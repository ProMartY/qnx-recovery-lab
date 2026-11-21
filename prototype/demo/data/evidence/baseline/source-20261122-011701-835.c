/* QNX IPC and process-recovery demonstration with simulated output only. */
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/neutrino.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define WORKER_PATH "/proc/boot/recovery-lab"
#define PROTOCOL_MAGIC UINT32_C(0x524c4142)
#define PROTOCOL_VERSION UINT32_C(1)
#define TICK_CODE (_PULSE_CODE_MINAVAIL + 1)
#define TICK_MS UINT64_C(50)
#define SCENARIO_LIMIT_MS UINT64_C(20000)
#define REAP_LIMIT_MS UINT64_C(1000)
#define VALIDATION_COUNT 3U
#define RECOVERY_COUNT 8U
#define HEALTHY_COUNT 12U

enum scenario { HEALTHY, CRASH, STALL, INVALID, CRASH_LOOP, REPLAY, WRONG_GENERATION };
enum state { VALIDATING, RUNNING, HOLDING, FAILED, STOPPED, LOCKED_OUT };
enum message_kind { PROPOSAL = 1, FAULT_NOTICE = 2 };

struct configuration {
    int scenario;
    unsigned fault_at;
    unsigned watchdog_ms;
    unsigned restart_limit;
};

struct proposal {
    uint32_t magic;
    uint32_t version;
    uint32_t kind;
    uint32_t generation;
    uint32_t seq;
    int32_t value;
};

union incoming {
    struct _pulse pulse;
    struct proposal proposal;
};

struct supervisor {
    struct configuration config;
    enum scenario scenario;
    enum state state;
    int chid;
    int timer_coid;
    timer_t timer;
    bool timer_created;
    pid_t worker_pid;
    uint32_t generation;
    uint32_t last_seq;
    unsigned fresh;
    unsigned recovered_valid;
    unsigned restarts;
    unsigned holds;
    unsigned recoveries;
    unsigned injections;
    unsigned fault_notices;
    unsigned accepted;
    unsigned rejected;
    unsigned invalid_outputs;
    int output;
    uint64_t started_ms;
    uint64_t now_ms;
    uint64_t last_valid_ms;
    uint64_t holding_ms;
    uint64_t last_tick_ms;
    uint64_t max_tick_gap_ms;
    uint64_t recovery_delay_ms;
    bool restart_pending;
    bool fault_announced;
    bool fault_detected;
    bool injection_observed;
    bool generation_fault_announced;
    bool generation_fault_observed;
    bool held_after_fault;
    bool resumed;
    bool completed;
    bool failed;
};

static volatile sig_atomic_t interrupted;

static const char *scenario_name(enum scenario scenario)
{
    static const char *const names[] = {
        "healthy", "crash", "stall", "invalid", "crash_loop", "replay", "wrong_generation"
    };
    return names[scenario];
}

static const char *state_name(enum state state)
{
    static const char *const names[] = {
        "validating", "running", "holding", "failed", "stopped", "locked_out"
    };
    return names[state];
}

static int monotonic_ms(uint64_t *value)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) == -1) {
        return -1;
    }
    *value = (uint64_t)now.tv_sec * UINT64_C(1000)
           + (uint64_t)now.tv_nsec / UINT64_C(1000000);
    return 0;
}

static void trace(const struct supervisor *supervisor, const char *event,
                  uint32_t seq, int proposed, const char *reason)
{
    printf("RECOVERY_EVENT {\"scenario\":\"%s\",\"t_ms\":%" PRIu64
           ",\"event\":\"%s\",\"state\":\"%s\",\"generation\":%" PRIu32
           ",\"seq\":%" PRIu32 ",\"output\":%d,\"proposed_output\":%d,\"reason\":\"%s\"}\n",
           scenario_name(supervisor->scenario),
           supervisor->now_ms - supervisor->started_ms, event,
           state_name(supervisor->state), supervisor->generation,
           seq, supervisor->output, proposed, reason);
}

static void set_output(struct supervisor *supervisor, int value)
{
    supervisor->output = value;
    if (value != 0 && (value < 20 || value > 60)) {
        ++supervisor->invalid_outputs;
    }
}

static void fail(struct supervisor *supervisor, const char *reason)
{
    supervisor->failed = true;
    supervisor->state = FAILED;
    set_output(supervisor, 0);
    trace(supervisor, "error", supervisor->last_seq, 0, reason);
}

static void handle_signal(int signal_number)
{
    interrupted = signal_number;
}

static int parse_number(const char *text, long minimum, long maximum, long *value)
{
    for (const char *cursor = text; *cursor != '\0'; ++cursor) {
        if (*cursor < '0' || *cursor > '9') {
            return -1;
        }
    }
    char *end;
    errno = 0;
    long parsed = strtol(text, &end, 10);
    if (errno != 0 || *text == '\0' || *end != '\0'
        || parsed < minimum || parsed > maximum) {
        return -1;
    }
    *value = parsed;
    return 0;
}

static int parse_scenario(const char *text)
{
    for (enum scenario scenario = HEALTHY; scenario <= WRONG_GENERATION;
         scenario = (enum scenario)(scenario + 1)) {
        if (strcmp(text, scenario_name(scenario)) == 0) {
            return scenario;
        }
    }
    return -1;
}

static int parse_configuration(int argc, char **argv, struct configuration *config)
{
    *config = (struct configuration){
        .scenario = -1, .fault_at = 8, .watchdog_ms = 700, .restart_limit = 2
    };
    unsigned seen = 0;
    for (int index = 1; index < argc; ++index) {
        const char *argument = argv[index];
        unsigned option;
        long value;
        if (strncmp(argument, "--scenario=", 11) == 0) {
            option = 1U;
            const char *name = argument + 11;
            config->scenario = parse_scenario(name);
            if (config->scenario == -1 && strcmp(name, "all") != 0) {
                return -1;
            }
        } else if (strncmp(argument, "--fault-at=", 11) == 0) {
            option = 2U;
            if (parse_number(argument + 11, 4, 20, &value) == -1) {
                return -1;
            }
            config->fault_at = (unsigned)value;
        } else if (strncmp(argument, "--watchdog-ms=", 14) == 0) {
            option = 4U;
            if (parse_number(argument + 14, 300, 2000, &value) == -1) {
                return -1;
            }
            config->watchdog_ms = (unsigned)value;
        } else if (strncmp(argument, "--restart-limit=", 16) == 0) {
            option = 8U;
            if (parse_number(argument + 16, 0, 3, &value) == -1) {
                return -1;
            }
            config->restart_limit = (unsigned)value;
        } else {
            return -1;
        }
        if ((seen & option) != 0) {
            return -1;
        }
        seen |= option;
    }
    return 0;
}

static int send_worker_message(int coid, const struct proposal *message,
                               unsigned watchdog_ms)
{
    uint64_t timeout_ns = (uint64_t)watchdog_ms * UINT64_C(1000000);
    if (TimerTimeout(CLOCK_MONOTONIC, _NTO_TIMEOUT_SEND | _NTO_TIMEOUT_REPLY,
                     NULL, &timeout_ns, NULL) == -1) {
        return -1;
    }
    /* The timed operation must be the next kernel call in this thread. */
    return MsgSend(coid, message, sizeof(*message), NULL, 0) == -1 ? -1 : 0;
}

static int worker_main(int argc, char **argv)
{
    long parent_pid;
    long parent_chid;
    long generation;
    long fault_at;
    long watchdog_ms;
    if (argc != 8
        || parse_number(argv[2], 1, INT_MAX, &parent_pid) == -1
        || parse_number(argv[3], 0, INT_MAX, &parent_chid) == -1
        || parse_number(argv[4], 1, 4, &generation) == -1
        || parse_number(argv[6], 4, 20, &fault_at) == -1
        || parse_number(argv[7], 300, 2000, &watchdog_ms) == -1) {
        return 20;
    }
    int selected = parse_scenario(argv[5]);
    if (selected == -1) {
        return 21;
    }
    enum scenario scenario = (enum scenario)selected;
    int coid = ConnectAttach(0, (pid_t)parent_pid, (int)parent_chid,
                             _NTO_SIDE_CHANNEL, 0);
    if (coid == -1) {
        return 22;
    }

    struct proposal message = {
        .magic = PROTOCOL_MAGIC,
        .version = PROTOCOL_VERSION,
        .kind = PROPOSAL,
        .generation = (uint32_t)generation,
        .seq = 0,
        .value = 0
    };
    const struct timespec interval = { .tv_sec = 0, .tv_nsec = 100000000L };
    for (;;) {
        ++message.seq;
        message.kind = PROPOSAL;
        message.value = 20 + (int32_t)((message.seq * 7U) % 41U);
        struct proposal outgoing = message;
        if (scenario != HEALTHY && (generation == 1 || scenario == CRASH_LOOP)
            && message.seq == (uint32_t)fault_at) {
            struct proposal notice = message;
            notice.kind = FAULT_NOTICE;
            notice.value = 0;
            if (send_worker_message(coid, &notice, (unsigned)watchdog_ms) == -1) {
                (void)ConnectDetach(coid);
                return 23;
            }
            if (scenario == CRASH || scenario == CRASH_LOOP) {
                _exit(42);
            }
            if (scenario == STALL) {
                for (;;) {
                    (void)pause();
                }
            }
            if (scenario == INVALID) {
                outgoing.value = 999;
            } else if (scenario == REPLAY) {
                outgoing.seq = (uint32_t)fault_at - 1U;
            } else if (scenario == WRONG_GENERATION) {
                outgoing.generation = 0;
            }
        }
        if (send_worker_message(coid, &outgoing, (unsigned)watchdog_ms) == -1) {
            (void)ConnectDetach(coid);
            return 24;
        }
        struct timespec remaining = interval;
        while (nanosleep(&remaining, &remaining) == -1) {
            if (errno != EINTR) {
                (void)ConnectDetach(coid);
                return 25;
            }
        }
    }
}

static int spawn_worker(struct supervisor *supervisor)
{
    char parent_pid[32];
    char parent_chid[32];
    char generation[32];
    char fault_at[32];
    char watchdog_ms[32];
    (void)snprintf(parent_pid, sizeof(parent_pid), "%ld", (long)getpid());
    (void)snprintf(parent_chid, sizeof(parent_chid), "%d", supervisor->chid);
    (void)snprintf(generation, sizeof(generation), "%" PRIu32,
                   supervisor->generation);
    (void)snprintf(fault_at, sizeof(fault_at), "%u", supervisor->config.fault_at);
    (void)snprintf(watchdog_ms, sizeof(watchdog_ms), "%u", supervisor->config.watchdog_ms);
    char *arguments[] = {
        WORKER_PATH, "--worker", parent_pid, parent_chid, generation,
        (char *)scenario_name(supervisor->scenario), fault_at, watchdog_ms, NULL
    };
    pid_t child = -1;
    int error = posix_spawn(&child, WORKER_PATH, NULL, NULL, arguments, NULL);
    if (error != 0) {
        fprintf(stderr, "posix_spawn: %s\n", strerror(error));
        fail(supervisor, "spawn_failed");
        return -1;
    }
    supervisor->worker_pid = child;
    if (monotonic_ms(&supervisor->now_ms) == -1) {
        fail(supervisor, "spawn_clock_failed");
        return -1;
    }
    supervisor->last_seq = 0;
    supervisor->fresh = 0;
    supervisor->recovered_valid = 0;
    supervisor->generation_fault_announced = false;
    supervisor->generation_fault_observed = false;
    supervisor->last_valid_ms = supervisor->now_ms;
    supervisor->state = VALIDATING;
    supervisor->restart_pending = false;
    set_output(supervisor, 0);
    trace(supervisor, "worker_started", 0, 0, "fresh_validation_required");
    return 0;
}

static int request_kill(struct supervisor *supervisor)
{
    if (supervisor->worker_pid > 0
        && kill(supervisor->worker_pid, SIGKILL) == -1 && errno != ESRCH) {
        fail(supervisor, "kill_failed");
        return -1;
    }
    return 0;
}

static void observe_injection(struct supervisor *supervisor)
{
    if (!supervisor->generation_fault_observed) {
        supervisor->generation_fault_observed = true;
        supervisor->injection_observed = true;
        ++supervisor->injections;
    }
}

static void hold_and_restart(struct supervisor *supervisor, const char *reason)
{
    if (supervisor->restart_pending || supervisor->failed) {
        return;
    }
    supervisor->state = HOLDING;
    set_output(supervisor, 0);
    ++supervisor->holds;
    supervisor->holding_ms = supervisor->now_ms;
    supervisor->held_after_fault = supervisor->fault_announced;
    supervisor->fault_detected = true;
    trace(supervisor, "hold", supervisor->last_seq, 0, reason);
    if (!supervisor->generation_fault_observed) {
        fail(supervisor, "unexpected_fault");
        return;
    }
    if (supervisor->restarts >= supervisor->config.restart_limit) {
        supervisor->state = LOCKED_OUT;
        supervisor->completed = true;
        trace(supervisor, "locked_out", supervisor->last_seq, 0,
              "restart_budget_exhausted");
        (void)request_kill(supervisor);
        return;
    }
    supervisor->restart_pending = true;
    (void)request_kill(supervisor);
}

static void restart_reaped_worker(struct supervisor *supervisor)
{
    ++supervisor->generation;
    if (spawn_worker(supervisor) == 0) {
        ++supervisor->restarts;
        trace(supervisor, "restart", 0, 0, "previous_worker_reaped");
    }
}

static void on_tick(struct supervisor *supervisor)
{
    uint64_t gap = supervisor->now_ms - supervisor->last_tick_ms;
    if (gap > supervisor->max_tick_gap_ms) {
        supervisor->max_tick_gap_ms = gap;
    }
    supervisor->last_tick_ms = supervisor->now_ms;
    if (supervisor->now_ms - supervisor->started_ms >= SCENARIO_LIMIT_MS) {
        fail(supervisor, "scenario_deadline");
        return;
    }
    if (supervisor->worker_pid > 0) {
        int status = 0;
        pid_t result = waitpid(supervisor->worker_pid, &status, WNOHANG);
        if (result == -1 && errno != EINTR) {
            fail(supervisor, "waitpid_failed");
            return;
        }
        if (result > 0) {
            supervisor->worker_pid = -1;
            bool injected_crash = (supervisor->scenario == CRASH
                                    || supervisor->scenario == CRASH_LOOP)
                               && (supervisor->generation == 1
                                    || supervisor->scenario == CRASH_LOOP)
                               && supervisor->generation_fault_announced
                               && WIFEXITED(status) && WEXITSTATUS(status) == 42;
            if (!supervisor->restart_pending) {
                if (injected_crash) {
                    observe_injection(supervisor);
                }
                printf("RECOVERY_EVENT {\"scenario\":\"%s\",\"t_ms\":%" PRIu64
                       ",\"event\":\"worker_exit\",\"state\":\"%s\",\"generation\":%" PRIu32
                       ",\"seq\":%" PRIu32 ",\"output\":%d,\"exit_code\":%d,\"signal\":%d"
                       ",\"reason\":\"%s\"}\n",
                       scenario_name(supervisor->scenario),
                       supervisor->now_ms - supervisor->started_ms,
                       state_name(supervisor->state), supervisor->generation,
                       supervisor->last_seq, supervisor->output,
                       WIFEXITED(status) ? WEXITSTATUS(status) : -1,
                       WIFSIGNALED(status) ? WTERMSIG(status) : 0,
                       injected_crash ? "injected_exit_42" : "unexpected_exit");
                hold_and_restart(supervisor,
                                 injected_crash ? "worker_crash" : "worker_exit");
            }
        }
    }
    if (supervisor->failed || supervisor->completed) {
        return;
    }
    if (supervisor->restart_pending) {
        if (supervisor->worker_pid == -1) {
            restart_reaped_worker(supervisor);
        } else if (supervisor->now_ms - supervisor->holding_ms >= REAP_LIMIT_MS) {
            fail(supervisor, "worker_reap_deadline");
        }
        return;
    }
    if (supervisor->now_ms - supervisor->last_valid_ms >= supervisor->config.watchdog_ms) {
        if (supervisor->scenario == STALL && supervisor->generation == 1
            && supervisor->generation_fault_announced) {
            observe_injection(supervisor);
        }
        hold_and_restart(supervisor, "heartbeat_timeout");
    }
}

static const char *message_error(const struct supervisor *supervisor,
                                 const struct proposal *message,
                                 const struct _msg_info *info)
{
    if (info->pid != supervisor->worker_pid || supervisor->restart_pending) {
        return "sender_pid";
    }
    if (info->msglen != (ssize_t)sizeof(*message)
        || info->srcmsglen != (ssize_t)sizeof(*message)) {
        return "message_size";
    }
    if (message->magic != PROTOCOL_MAGIC || message->version != PROTOCOL_VERSION) {
        return "protocol";
    }
    if (message->generation != supervisor->generation) {
        return "generation";
    }
    if (message->seq != supervisor->last_seq + 1U) {
        return "sequence";
    }
    if (message->kind != PROPOSAL && message->kind != FAULT_NOTICE) {
        return "message_kind";
    }
    if (message->kind == PROPOSAL && (message->value < 20 || message->value > 60)) {
        return "command_range";
    }
    if (message->kind == PROPOSAL
        && supervisor->now_ms - supervisor->last_valid_ms >= supervisor->config.watchdog_ms) {
        return "proposal_expired";
    }
    if (message->kind == FAULT_NOTICE
        && (supervisor->scenario == HEALTHY
            || (supervisor->generation != 1 && supervisor->scenario != CRASH_LOOP)
            || message->seq != supervisor->config.fault_at || message->value != 0
            || supervisor->generation_fault_announced)) {
        return "fault_notice";
    }
    return NULL;
}

static void on_message(struct supervisor *supervisor,
                       const struct proposal *message, const struct _msg_info *info)
{
    const char *error = message_error(supervisor, message, info);
    if (error != NULL) {
        ++supervisor->rejected;
        if (info->pid == supervisor->worker_pid && !supervisor->restart_pending) {
            supervisor->state = HOLDING;
            set_output(supervisor, 0);
        }
        printf("RECOVERY_EVENT {\"scenario\":\"%s\",\"t_ms\":%" PRIu64
               ",\"event\":\"rejected\",\"state\":\"%s\",\"generation\":%" PRIu32
               ",\"received_generation\":%" PRIu32 ",\"seq\":%" PRIu32
               ",\"output\":%d,\"proposed_output\":%d,\"reason\":\"%s\"}\n",
               scenario_name(supervisor->scenario),
               supervisor->now_ms - supervisor->started_ms,
               state_name(supervisor->state), supervisor->generation,
               message->generation, message->seq, supervisor->output, message->value, error);
        if (info->pid == supervisor->worker_pid && !supervisor->restart_pending) {
            if (supervisor->generation == 1
                && supervisor->generation_fault_announced
                && message->kind == PROPOSAL) {
                bool valid_value = message->value >= 20 && message->value <= 60;
                bool injected_invalid = supervisor->scenario == INVALID
                    && strcmp(error, "command_range") == 0
                    && message->generation == supervisor->generation
                    && message->seq == supervisor->config.fault_at && message->value == 999;
                bool injected_replay = supervisor->scenario == REPLAY
                    && strcmp(error, "sequence") == 0
                    && message->generation == supervisor->generation
                    && message->seq == supervisor->config.fault_at - 1U && valid_value;
                bool injected_generation = supervisor->scenario == WRONG_GENERATION
                    && strcmp(error, "generation") == 0 && message->generation == 0
                    && message->seq == supervisor->config.fault_at && valid_value;
                if (injected_invalid || injected_replay || injected_generation) {
                    observe_injection(supervisor);
                }
            }
            hold_and_restart(supervisor, error);
        }
        return;
    }
    if (message->kind == FAULT_NOTICE) {
        supervisor->fault_announced = true;
        supervisor->generation_fault_announced = true;
        ++supervisor->fault_notices;
        trace(supervisor, "fault_injected", message->seq, 0,
              scenario_name(supervisor->scenario));
        return;
    }

    bool was_running = supervisor->state == RUNNING;
    supervisor->last_seq = message->seq;
    supervisor->last_valid_ms = supervisor->now_ms;
    ++supervisor->accepted;
    ++supervisor->fresh;
    if (supervisor->state == VALIDATING && supervisor->fresh >= VALIDATION_COUNT) {
        supervisor->state = RUNNING;
        set_output(supervisor, message->value);
        if (supervisor->generation >= 2 && supervisor->held_after_fault) {
            supervisor->resumed = true;
            ++supervisor->recoveries;
            supervisor->recovery_delay_ms = supervisor->now_ms - supervisor->holding_ms;
            set_output(supervisor, message->value);
            trace(supervisor, "resumed", message->seq, message->value,
                  "three_fresh_proposals");
        } else {
            trace(supervisor, "validated", message->seq, message->value,
                  "three_fresh_proposals");
        }
    }
    if (supervisor->state == RUNNING) {
        set_output(supervisor, message->value);
    }
    trace(supervisor, "proposal", message->seq, message->value, "accepted");
    if (supervisor->generation >= 2 && was_running) {
        ++supervisor->recovered_valid;
    }
    if ((supervisor->scenario == HEALTHY && supervisor->accepted >= HEALTHY_COUNT)
        || (supervisor->scenario != HEALTHY && supervisor->scenario != CRASH_LOOP
            && supervisor->recovered_valid >= RECOVERY_COUNT)) {
        supervisor->completed = true;
    }
}

static void cleanup(struct supervisor *supervisor)
{
    if (!supervisor->failed) {
        if (supervisor->state != LOCKED_OUT) {
            supervisor->state = STOPPED;
        }
        set_output(supervisor, 0);
        trace(supervisor, "scenario_complete", supervisor->last_seq, 0,
              "output_held_before_shutdown");
    }
    if (supervisor->timer_created && timer_delete(supervisor->timer) == -1) {
        fail(supervisor, "timer_delete_failed");
    }
    if (supervisor->worker_pid > 0) {
        (void)request_kill(supervisor);
        const struct timespec delay = { .tv_sec = 0, .tv_nsec = 10000000L };
        for (unsigned attempt = 0; attempt < 200 && supervisor->worker_pid > 0;
             ++attempt) {
            pid_t result = waitpid(supervisor->worker_pid, NULL, WNOHANG);
            if (result > 0) {
                supervisor->worker_pid = -1;
                break;
            }
            if (result == -1 && errno != EINTR) {
                fail(supervisor, "cleanup_waitpid_failed");
                break;
            }
            (void)nanosleep(&delay, NULL);
        }
        if (supervisor->worker_pid > 0) {
            fail(supervisor, "cleanup_reap_deadline");
        }
    }
    if (supervisor->timer_coid != -1 && ConnectDetach(supervisor->timer_coid) == -1) {
        fail(supervisor, "connect_detach_failed");
    }
    if (supervisor->chid != -1 && ChannelDestroy(supervisor->chid) == -1) {
        fail(supervisor, "channel_destroy_failed");
    }
}

static bool run_scenario(enum scenario scenario, const struct configuration *config)
{
    struct supervisor supervisor;
    memset(&supervisor, 0, sizeof(supervisor));
    supervisor.config = *config;
    supervisor.scenario = scenario;
    supervisor.state = VALIDATING;
    supervisor.chid = -1;
    supervisor.timer_coid = -1;
    supervisor.worker_pid = -1;
    supervisor.generation = 1;
    if (monotonic_ms(&supervisor.started_ms) == -1) {
        fprintf(stderr, "clock_gettime failed\n");
        return false;
    }
    supervisor.now_ms = supervisor.started_ms;
    supervisor.last_tick_ms = supervisor.started_ms;
    trace(&supervisor, "start", 0, 0, "simulated_output");

    /* A child process attaches to this public channel by parent PID and chid. */
    supervisor.chid = ChannelCreate(0);
    if (supervisor.chid == -1) {
        fail(&supervisor, "channel_create_failed");
        goto finished;
    }
    supervisor.timer_coid = ConnectAttach(0, 0, supervisor.chid, _NTO_SIDE_CHANNEL, 0);
    if (supervisor.timer_coid == -1) {
        fail(&supervisor, "timer_connection_failed");
        goto finished;
    }
    struct sigevent event;
    memset(&event, 0, sizeof(event));
    SIGEV_PULSE_INIT(&event, supervisor.timer_coid, SIGEV_PULSE_PRIO_INHERIT,
                     TICK_CODE, 0);
    if (timer_create(CLOCK_MONOTONIC, &event, &supervisor.timer) == -1) {
        fail(&supervisor, "timer_create_failed");
        goto finished;
    }
    supervisor.timer_created = true;
    struct itimerspec interval;
    memset(&interval, 0, sizeof(interval));
    interval.it_value.tv_nsec = (long)(TICK_MS * UINT64_C(1000000));
    interval.it_interval = interval.it_value;
    if (timer_settime(supervisor.timer, 0, &interval, NULL) == -1) {
        fail(&supervisor, "timer_settime_failed");
        goto finished;
    }
    if (spawn_worker(&supervisor) == -1) {
        goto finished;
    }

    while (!supervisor.completed && !supervisor.failed) {
        if (interrupted != 0) {
            fail(&supervisor, "interrupted");
            break;
        }
        union incoming incoming;
        struct _msg_info info;
        memset(&incoming, 0, sizeof(incoming));
        memset(&info, 0, sizeof(info));
        uint64_t receive_timeout = UINT64_C(100000000);
        if (TimerTimeout(CLOCK_MONOTONIC, _NTO_TIMEOUT_RECEIVE,
                         NULL, &receive_timeout, NULL) == -1) {
            fail(&supervisor, "receive_timeout_setup_failed");
            break;
        }
        rcvid_t rcvid = MsgReceive(supervisor.chid, &incoming, sizeof(incoming), &info);
        int receive_error = errno;
        /* Release every synchronous sender before lifecycle actions. */
        if (rcvid > 0 && MsgReply(rcvid, 0, NULL, 0) == -1) {
            int reply_error = errno;
            if (reply_error != ESRCH) {
                fail(&supervisor, "reply_failed");
                break;
            }
            continue;
        }
        if (monotonic_ms(&supervisor.now_ms) == -1) {
            fail(&supervisor, "clock_failed");
            break;
        }
        if (supervisor.now_ms - supervisor.started_ms >= SCENARIO_LIMIT_MS) {
            fail(&supervisor, "scenario_deadline");
            break;
        }
        if (rcvid == -1) {
            if (receive_error != EINTR && receive_error != ETIMEDOUT) {
                fail(&supervisor, "receive_failed");
                break;
            }
            on_tick(&supervisor);
        } else if (rcvid == 0) {
            if (incoming.pulse.code == TICK_CODE) {
                on_tick(&supervisor);
            }
        } else {
            on_message(&supervisor, &incoming.proposal, &info);
        }
    }

finished:
    cleanup(&supervisor);
    bool passed = !supervisor.failed && supervisor.completed
               && supervisor.invalid_outputs == 0 && supervisor.output == 0;
    const char *outcome = "failed";
    if (scenario == HEALTHY) {
        passed = passed && supervisor.restarts == 0 && supervisor.rejected == 0
              && !supervisor.fault_announced && !supervisor.fault_detected
              && supervisor.injections == 0 && supervisor.fault_notices == 0
              && supervisor.holds == 0 && supervisor.accepted >= HEALTHY_COUNT;
        if (passed) {
            outcome = "healthy";
        }
    } else if (supervisor.state == LOCKED_OUT) {
        passed = passed && (scenario == CRASH_LOOP || config->restart_limit == 0)
              && supervisor.restarts == config->restart_limit
              && supervisor.injections == supervisor.restarts + 1U
              && supervisor.holds == supervisor.injections
              && supervisor.fault_notices == supervisor.injections
              && supervisor.generation == supervisor.restarts + 1U
              && supervisor.generation_fault_observed && supervisor.held_after_fault;
        if (passed) {
            outcome = "contained";
        }
    } else {
        passed = passed && scenario != CRASH_LOOP && config->restart_limit > 0
              && supervisor.restarts == 1 && supervisor.fault_announced
              && supervisor.fault_detected && supervisor.injection_observed
              && supervisor.held_after_fault && supervisor.resumed
              && supervisor.recovered_valid >= RECOVERY_COUNT
              && supervisor.injections == 1 && supervisor.fault_notices == 1
              && supervisor.holds == 1 && supervisor.recoveries == 1;
        if (passed) {
            outcome = "recovered";
        }
    }
    bool rejection_expected = scenario == INVALID || scenario == REPLAY
                           || scenario == WRONG_GENERATION;
    if (supervisor.rejected != (rejection_expected ? 1U : 0U)) {
        passed = false;
        outcome = "failed";
    }
    char recovery_delay[32] = "null";
    if (passed && strcmp(outcome, "recovered") == 0) {
        (void)snprintf(recovery_delay, sizeof(recovery_delay), "%" PRIu64,
                       supervisor.recovery_delay_ms);
    }
    printf("RECOVERY_EVENT {\"scenario\":\"%s\",\"t_ms\":%" PRIu64
           ",\"event\":\"summary\",\"state\":\"%s\",\"generation\":%" PRIu32
           ",\"seq\":%" PRIu32 ",\"output\":%d,\"passed\":%s,\"outcome\":\"%s\",\"restarts\":%u"
           ",\"holds\":%u,\"recoveries\":%u,\"accepted\":%u,\"rejected\":%u,\"held_after_fault\":%s"
           ",\"resumed\":%s,\"fault_announced\":%s,\"injection_observed\":%s"
           ",\"fault_detected\":%s,\"invalid_outputs\":%u,\"recovered_valid\":%u"
           ",\"max_tick_gap_ms\":%" PRIu64 ",\"injections\":%u,\"fault_notices\":%u"
           ",\"fault_at\":%u,\"watchdog_ms\":%u,\"restart_limit\":%u"
           ",\"recovery_delay_ms\":%s}\n",
           scenario_name(scenario), supervisor.now_ms - supervisor.started_ms,
           state_name(supervisor.state), supervisor.generation, supervisor.last_seq,
           supervisor.output, passed ? "true" : "false", outcome, supervisor.restarts,
           supervisor.holds, supervisor.recoveries, supervisor.accepted, supervisor.rejected,
           supervisor.held_after_fault ? "true" : "false",
           supervisor.resumed ? "true" : "false",
           supervisor.fault_announced ? "true" : "false",
           supervisor.injection_observed ? "true" : "false",
           supervisor.fault_detected ? "true" : "false",
           supervisor.invalid_outputs, supervisor.recovered_valid,
           supervisor.max_tick_gap_ms, supervisor.injections, supervisor.fault_notices,
           config->fault_at, config->watchdog_ms, config->restart_limit, recovery_delay);
    return passed;
}

static void print_json_string(const char *text)
{
    putchar('"');
    for (const unsigned char *cursor = (const unsigned char *)text;
         *cursor != '\0'; ++cursor) {
        if (*cursor == '"' || *cursor == '\\') {
            putchar('\\');
            putchar(*cursor);
        } else if (*cursor < 0x20U) {
            printf("\\u%04x", (unsigned)*cursor);
        } else {
            putchar(*cursor);
        }
    }
    putchar('"');
}

int main(int argc, char **argv)
{
    (void)setvbuf(stdout, NULL, _IONBF, 0);
    if (argc > 1 && strcmp(argv[1], "--worker") == 0) {
        return worker_main(argc, argv);
    }
    struct configuration config;
    if (parse_configuration(argc, argv, &config) == -1) {
        fprintf(stderr, "Usage: /proc/boot/recovery-lab [--scenario=all|healthy|crash|stall|invalid|crash_loop|replay|wrong_generation] "
                "[--fault-at=4..20] [--watchdog-ms=300..2000] [--restart-limit=0..3]\n");
        printf("RECOVERY_LAB_EXIT=2\n");
        return 2;
    }
    struct utsname environment;
    if (uname(&environment) == -1) {
        perror("uname");
        printf("RECOVERY_LAB_EXIT=2\n");
        return 2;
    }
    printf("RECOVERY_ENV {\"os\":");
    print_json_string(environment.sysname);
    printf(",\"release\":");
    print_json_string(environment.release);
    printf(",\"machine\":");
    print_json_string(environment.machine);
    printf("}\n");
    printf("RECOVERY_CONFIG {\"scenario\":\"%s\",\"fault_at\":%u,\"watchdog_ms\":%u,\"restart_limit\":%u}\n",
           config.scenario == -1 ? "all" : scenario_name((enum scenario)config.scenario),
           config.fault_at, config.watchdog_ms, config.restart_limit);

    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = handle_signal;
    (void)sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, NULL) == -1
        || sigaction(SIGTERM, &action, NULL) == -1) {
        perror("sigaction");
        printf("RECOVERY_LAB_EXIT=2\n");
        return 2;
    }
    action.sa_handler = SIG_DFL;
    if (sigaction(SIGCHLD, &action, NULL) == -1) {
        perror("sigaction SIGCHLD");
        printf("RECOVERY_LAB_EXIT=2\n");
        return 2;
    }

    unsigned failures = 0;
    for (enum scenario scenario = HEALTHY; scenario <= WRONG_GENERATION;
         scenario = (enum scenario)(scenario + 1)) {
        if (config.scenario != -1 && config.scenario != (int)scenario) {
            continue;
        }
        if (!run_scenario(scenario, &config)) {
            ++failures;
        }
        if (interrupted != 0) {
            break;
        }
    }
    int result = failures == 0 ? 0 : 1;
    printf("RECOVERY_LAB_EXIT=%d\n", result);
    return result;
}
