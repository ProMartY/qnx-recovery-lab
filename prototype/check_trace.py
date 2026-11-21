"""Check observable recovery behavior in a recorded QNX guest trace."""

import json
import math
import sys
from pathlib import Path


SCENARIOS = ("healthy", "crash", "stall", "invalid", "crash_loop", "replay", "wrong_generation")
EVENTS = {
    "start", "worker_started", "proposal", "validated", "resumed",
    "fault_injected", "worker_exit", "rejected", "hold", "restart",
    "locked_out", "scenario_complete", "summary",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def is_integer(value):
    return type(value) is int


def read_config(data):
    suite_version = data.get("suite_version", 1)
    require(is_integer(suite_version) and suite_version in (1, 2),
            "Unsupported trace suite version")
    if "config" not in data:
        require(suite_version == 1, "Suite version 2 requires a trace configuration")
        return SCENARIOS[:4], {"fault_at": 8, "watchdog_ms": 700, "restart_limit": 2}, False
    config = data["config"]
    require(isinstance(config, dict), "Invalid trace configuration")
    selected = config.get("scenario")
    require(selected == "all" or selected in SCENARIOS, "Invalid selected scenario")
    for key, minimum in (("fault_at", 1), ("watchdog_ms", 1), ("restart_limit", 0)):
        require(is_integer(config.get(key)) and config[key] >= minimum,
                f"Invalid configuration value: {key}")
    suite_names = SCENARIOS if suite_version == 2 else SCENARIOS[:5]
    names = suite_names if selected == "all" else (selected,)
    return names, config, True


def check_generation(name, generation, events, fault_at, watchdog_ms):
    prefix = f"{name}, generation {generation}"
    starts = [event for event in events if event["event"] == "worker_started"]
    require(len(starts) == 1 and starts[0]["seq"] == 0,
            f"{prefix}: missing or duplicate worker start")
    worker_index = events.index(starts[0])
    require(all(event["event"] == "start" for event in events[:worker_index]),
            f"{prefix}: activity before worker start")
    proposals = []
    for index, event in enumerate(events):
        kind = event["event"]
        require(is_integer(event["seq"]) and event["seq"] >= 0,
                f"{prefix}: invalid sequence number")
        if kind in ("validated", "resumed"):
            require(len(proposals) == 2 and event["seq"] == 3,
                    f"{prefix}: running before three fresh proposals")
            require(index + 1 < len(events), f"{prefix}: missing third proposal")
            third = events[index + 1]
            require(third["event"] == "proposal"
                    and all(third[key] == event[key] for key in
                            ("seq", "t_ms", "output", "proposed_output", "state")),
                    f"{prefix}: validation does not match the third proposal")
            expected_kind = "validated" if generation == 1 else "resumed"
            require(kind == expected_kind, f"{prefix}: incorrect validation transition")
        if kind == "proposal":
            require(event["seq"] == len(proposals) + 1,
                    f"{prefix}: proposal sequence gap")
            value = event["proposed_output"]
            require(is_integer(value) and 20 <= value <= 60,
                    f"{prefix}: accepted out-of-range proposal")
            proposals.append(event)
            expected_state = "running" if len(proposals) >= 3 else "validating"
            expected_output = value if len(proposals) >= 3 else 0
            require(event["state"] == expected_state and event["output"] == expected_output,
                    f"{prefix}: proposal applied outside fresh validation")
            if event["seq"] == 3:
                require(index > 0 and events[index - 1]["event"] in ("validated", "resumed"),
                        f"{prefix}: third proposal has no validation transition")
        if event["state"] == "running":
            if kind in ("validated", "resumed"):
                expected_output = event["proposed_output"]
            else:
                require(len(proposals) >= 3, f"{prefix}: running before fresh validation")
                expected_output = proposals[-1]["proposed_output"]
            require(event["output"] == expected_output,
                    f"{prefix}: output differs from the accepted proposal")
        if kind in ("start", "worker_started", "restart"):
            require(event["state"] == "validating" and event["seq"] == 0,
                    f"{prefix}: invalid worker initialization")

    markers = [event for event in events if event["event"] in ("validated", "resumed")]
    require(len(markers) == int(len(proposals) >= 3),
            f"{prefix}: incorrect validation transition count")
    faults = [event for event in events if event["event"] == "fault_injected"]
    holds = [event for event in events if event["event"] == "hold"]
    exits = [event for event in events if event["event"] == "worker_exit"]
    rejected = [event for event in events if event["event"] == "rejected"]
    expected_fault = name == "crash_loop" or (name != "healthy" and generation == 1)
    require(len(faults) == len(holds) == int(expected_fault),
            f"{prefix}: fault was missing or escaped containment")
    if not expected_fault:
        require(not exits and not rejected, f"{prefix}: unexpected worker fault")
        return proposals

    fault, hold = faults[0], holds[0]
    fault_index = events.index(fault)
    hold_index = events.index(hold)
    require(fault["seq"] == fault_at and fault.get("reason") == name,
            f"{prefix}: incorrect fault injection")
    require(len(proposals) == fault_at - 1
            and all(event["event"] != "proposal" for event in events[fault_index + 1:]),
            f"{prefix}: proposals continued after the injected fault")
    expected_state = "running" if len(proposals) >= 3 else "validating"
    require(fault["state"] == expected_state and fault["proposed_output"] == 0,
            f"{prefix}: invalid fault notice state")
    require(fault_index < hold_index and hold["seq"] == fault_at - 1
            and hold["state"] == "holding" and hold["output"] == 0,
            f"{prefix}: invalid fault-to-hold transition")
    expected_reason = {"crash": "worker_crash", "crash_loop": "worker_crash",
                       "stall": "heartbeat_timeout", "invalid": "command_range",
                       "replay": "sequence", "wrong_generation": "generation"}[name]
    require(hold.get("reason") == expected_reason, f"{prefix}: incorrect hold reason")
    if name in ("crash", "crash_loop"):
        require(len(exits) == 1 and not rejected,
                f"{prefix}: missing observed crash")
        observed = exits[0]
        require(is_integer(observed.get("exit_code")) and observed["exit_code"] == 42
                and is_integer(observed.get("signal")) and observed["signal"] == 0,
                f"{prefix}: worker did not exit with code 42")
        require(observed["seq"] == fault_at - 1 and observed["state"] == expected_state,
                f"{prefix}: incorrect worker exit state")
    elif name in ("invalid", "replay", "wrong_generation"):
        require(len(rejected) == 1 and not exits,
                f"{prefix}: missing injected-message rejection")
        observed = rejected[0]
        expected_seq = fault_at - 1 if name == "replay" else fault_at
        require(observed["seq"] == expected_seq and observed["output"] == 0
                and observed["state"] == "holding" and observed.get("reason") == expected_reason,
                f"{prefix}: injected message was not safely rejected")
        if name == "invalid":
            require(observed["proposed_output"] == 999
                    and observed.get("received_generation", generation) == generation,
                    f"{prefix}: malformed output was not rejected")
        else:
            expected_generation = 0 if name == "wrong_generation" else generation
            require(20 <= observed["proposed_output"] <= 60
                    and is_integer(observed.get("received_generation"))
                    and observed["received_generation"] == expected_generation,
                    f"{prefix}: rejection does not demonstrate the injected protocol fault")
    else:
        require(not exits and not rejected, f"{prefix}: unexpected stall observation")
        observed = hold
        last_valid = proposals[-1] if proposals else starts[0]
        require(hold["t_ms"] - last_valid["t_ms"] >= watchdog_ms,
                f"{prefix}: watchdog fired before its configured deadline")
    require(fault_index < events.index(observed) <= hold_index,
            f"{prefix}: invalid fault observation ordering")
    require(all(event["event"] in ("locked_out", "scenario_complete", "summary")
                for event in events[hold_index + 1:]),
            f"{prefix}: activity continued after the worker was held")
    return proposals


def check_scenario(name, events, summary, config, modern):
    require(events, f"{name}: no events recorded")
    require(summary.get("passed") is True, f"{name}: guest reported failure")
    require(events[0]["event"] == "start"
            and json.dumps(events[-1], sort_keys=True, allow_nan=False)
            == json.dumps(summary, sort_keys=True, allow_nan=False),
            f"{name}: incomplete or inconsistent scenario trace")
    require(sum(event["event"] == "start" for event in events) == 1
            and sum(event["event"] == "summary" for event in events) == 1,
            f"{name}: duplicate scenario boundaries")
    require(all(type(event["t_ms"]) in (int, float) and math.isfinite(event["t_ms"])
                and event["t_ms"] >= 0 for event in events), f"{name}: invalid timestamp")
    require(all(a["t_ms"] <= b["t_ms"] for a, b in zip(events, events[1:])),
            f"{name}: time moved backwards")
    for event in events:
        require(isinstance(event["event"], str) and event["event"] in EVENTS,
                f"{name}: unexpected event {event['event']}")
        if "proposed_output" in event:
            require(is_integer(event["proposed_output"]), f"{name}: invalid proposed output")
        if "received_generation" in event:
            require(is_integer(event["received_generation"])
                    and event["received_generation"] >= 0,
                    f"{name}: invalid received generation")
        output = event["output"]
        require(is_integer(output) and (output == 0 or
                (event["state"] == "running" and 20 <= output <= 60)),
                f"{name}: nonzero output outside validated running state")
        require(is_integer(event["generation"]) and event["generation"] >= 1,
                f"{name}: invalid generation")
    require(all(a["generation"] <= b["generation"] for a, b in zip(events, events[1:])),
            f"{name}: generation moved backwards")
    generation_count = events[-1]["generation"]
    require(generation_count <= len(events), f"{name}: impossible generation count")
    require(set(event["generation"] for event in events) == set(range(1, generation_count + 1)),
            f"{name}: generation gap")
    per_generation = {}
    for generation in range(1, generation_count + 1):
        group = [event for event in events if event["generation"] == generation]
        per_generation[generation] = check_generation(
            name, generation, group, config["fault_at"], config["watchdog_ms"])
    proposals = [event for event in events if event["event"] == "proposal"]
    holds = [event for event in events if event["event"] == "hold"]
    restarts = [event for event in events if event["event"] == "restart"]
    rejected = [event for event in events if event["event"] == "rejected"]
    faults = [event for event in events if event["event"] == "fault_injected"]
    resumed = [event for event in events if event["event"] == "resumed"]
    lockouts = [event for event in events if event["event"] == "locked_out"]
    expected_outcome = "healthy" if name == "healthy" else "recovered"
    if name == "crash_loop" or (name != "healthy" and config["restart_limit"] == 0):
        expected_outcome = "contained"
    if modern:
        require(summary.get("outcome") == expected_outcome, f"{name}: incorrect outcome")
    terminal = "locked_out" if expected_outcome == "contained" else "stopped"
    completions = [event for event in events if event["event"] == "scenario_complete"]
    require(len(completions) == 1 and events[-2] == completions[0]
            and completions[0]["state"] == summary["state"] == terminal
            and summary["output"] == 0, f"{name}: invalid terminal state")
    for key, count in (("accepted", len(proposals)), ("rejected", len(rejected)),
                       ("holds", len(holds)), ("restarts", len(restarts)),
                       ("recoveries", len(resumed)), ("invalid_outputs", 0)):
        require(is_integer(summary[key]) and summary[key] == count,
                f"{name}: {key} count mismatch")
    if modern:
        require(is_integer(summary.get("injections")) and summary["injections"] == len(faults),
                f"{name}: observed injection count mismatch")
        require(is_integer(summary.get("fault_notices"))
                and summary["fault_notices"] == len(faults),
                f"{name}: fault notice count mismatch")
        for key in ("fault_at", "watchdog_ms", "restart_limit"):
            require(is_integer(summary.get(key)) and summary[key] == config[key],
                    f"{name}: summary configuration mismatch for {key}")
    for key, observed in (("fault_announced", bool(faults)), ("fault_detected", bool(holds)),
                          ("injection_observed", bool(faults)), ("held_after_fault", bool(holds)),
                          ("resumed", bool(resumed))):
        require(summary.get(key) is observed, f"{name}: incorrect {key} summary")
    require(len(restarts) <= config["restart_limit"] and generation_count == len(restarts) + 1,
            f"{name}: restart budget exceeded or generation count mismatch")
    for generation in range(2, generation_count + 1):
        group = [event for event in events if event["generation"] == generation]
        require(len(group) >= 2 and group[0]["event"] == "worker_started"
                and group[1]["event"] == "restart"
                and sum(event["event"] == "restart" for event in group) == 1,
                f"{name}: invalid restart sequence")
        prior_hold = next(event for event in holds if event["generation"] == generation - 1)
        require(events.index(prior_hold) < events.index(group[0]),
                f"{name}: restart occurred before hold")
    require(all(event["generation"] > 1 for event in restarts),
            f"{name}: initial worker counted as restart")
    recovered_valid = max(len(per_generation[generation_count]) - 3, 0) if generation_count > 1 else 0
    require(is_integer(summary["recovered_valid"]) and summary["recovered_valid"] == recovered_valid,
            f"{name}: recovered traffic count mismatch")
    require(summary["seq"] == completions[0]["seq"] == len(per_generation[generation_count]),
            f"{name}: terminal sequence differs from accepted traffic")
    if expected_outcome == "healthy":
        require(not holds and not restarts and not rejected and not lockouts,
                "healthy: unexpected intervention")
        require(len(proposals) >= 12, "healthy: insufficient proposals")
    elif expected_outcome == "recovered":
        require(len(faults) == len(holds) == len(restarts) == len(resumed) == 1 and not lockouts,
                f"{name}: expected one fault, hold, restart and recovery")
        require(recovered_valid >= 8, f"{name}: insufficient recovered traffic")
    else:
        require(len(holds) == len(restarts) + 1 and len(restarts) == config["restart_limit"]
                and len(lockouts) == 1, f"{name}: invalid restart-budget containment")
        lockout = lockouts[0]
        require(events.index(lockout) > events.index(holds[-1])
                and lockout["generation"] == generation_count
                and lockout["state"] == "locked_out"
                and lockout.get("reason") == "restart_budget_exhausted",
                f"{name}: missing lockout after final hold")
        require(all(event["event"] in ("scenario_complete", "summary")
                    and event["state"] == "locked_out" and event["output"] == 0
                    for event in events[events.index(lockout) + 1:]),
                f"{name}: activity continued after lockout")
    if modern:
        require("recovery_delay_ms" in summary, f"{name}: missing recovery delay")
        delay = summary.get("recovery_delay_ms")
        if expected_outcome == "recovered":
            require(type(delay) in (int, float) and math.isfinite(delay)
                    and delay == resumed[-1]["t_ms"] - holds[-1]["t_ms"],
                    f"{name}: incorrect recovery delay")
        else:
            require(delay is None, f"{name}: unexpected recovery delay")


def validate_trace(data):
    """Validate recorded events and summaries, returning the selected scenario names."""
    require(isinstance(data, dict), "Trace must be a JSON object")
    require(isinstance(data.get("environment"), dict), "Missing guest environment")
    for key in ("events", "scenarios"):
        require(isinstance(data.get(key), list)
                and all(isinstance(row, dict) and isinstance(row.get("scenario"), str)
                        for row in data[key]), f"Invalid trace {key}")
    try:
        require(is_integer(data["schema_version"]) and data["schema_version"] == 1,
                "Unsupported trace schema")
        require(data["environment"]["os"] == "QNX", "Evidence does not identify a QNX guest")
        names, config, modern = read_config(data)
        require(sorted(row["scenario"] for row in data["scenarios"]) == sorted(names),
                "Unexpected scenario summaries")
        require(set(row["scenario"] for row in data["events"]) == set(names),
                "Unexpected scenarios in recorded events")
        for name in names:
            summary = next(row for row in data["scenarios"] if row["scenario"] == name)
            events = [row for row in data["events"] if row["scenario"] == name]
            check_scenario(name, events, summary, config, modern)
    except (KeyError, StopIteration, TypeError, IndexError, OverflowError) as error:
        raise ValueError(f"Malformed trace: {error}") from None
    return names


def main():
    require(len(sys.argv) <= 2, "Usage: check_trace.py [trace.json]")
    trace = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "artifacts/latest.json"
    data = json.loads(trace.read_text(encoding="utf-8-sig"))
    for name in validate_trace(data):
        events = [row for row in data["events"] if row["scenario"] == name]
        print(f"{name}: verified from {len(events)} guest events")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, StopIteration, OSError, TypeError, IndexError) as error:
        sys.exit(f"Trace verification failed: {error}")
