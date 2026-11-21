"""Checker regressions using archived guest traces and explicit synthetic mutations."""

import copy
import json
import sys
import unittest
from pathlib import Path


PROTOTYPE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROTOTYPE))
from check_trace import SCENARIOS, validate_trace


ARCHIVES = (
    "run-20261119-000637-079.json",
    "run-20261120-230515-905.json",
    "run-20261120-230616-127.json",
    "run-20261120-230746-114.json",
    "run-20261120-230858-411.json",
)


def archived_trace(filename):
    return json.loads((PROTOTYPE / "tests/fixtures" / filename).read_text(encoding="utf-8-sig"))


def protocol_scenario(data, name):
    """Create a checker fixture, without claiming a new recorded QNX execution."""
    events = copy.deepcopy([event for event in data["events"] if event["scenario"] == "invalid"])
    fault_at = data["config"]["fault_at"]
    reason = "sequence" if name == "replay" else "generation"
    for event in events:
        event["scenario"] = name
        if event["event"] == "fault_injected":
            event["reason"] = name
        elif event["event"] == "rejected":
            event.update(reason=reason, seq=fault_at - 1 if name == "replay" else fault_at,
                         proposed_output=20 + (fault_at * 7) % 41,
                         received_generation=1 if name == "replay" else 0)
        elif event["event"] == "hold":
            event["reason"] = reason
    return events


def synthetic_suite():
    data = archived_trace(ARCHIVES[1])
    data["suite_version"] = 2
    for name in ("replay", "wrong_generation"):
        events = protocol_scenario(data, name)
        data["events"].extend(events)
        data["scenarios"].append(copy.deepcopy(events[-1]))
    return data


def synthetic_single(name, contained=False):
    data = archived_trace(ARCHIVES[3] if contained else ARCHIVES[1])
    data["suite_version"] = 2
    data["config"]["scenario"] = name
    data["events"] = protocol_scenario(data, name)
    data["scenarios"] = [copy.deepcopy(data["events"][-1])]
    return data


def event_named(data, kind, scenario):
    return next(event for event in data["events"]
                if event["event"] == kind and event["scenario"] == scenario)


def summary_named(data, scenario):
    return next(row for row in data["scenarios"] if row["scenario"] == scenario)


class TraceTests(unittest.TestCase):
    def test_archived_guest_traces_remain_valid(self):
        for filename in ARCHIVES:
            with self.subTest(filename=filename):
                validate_trace(archived_trace(filename))
        self.assertEqual(len(validate_trace(archived_trace(ARCHIVES[0]))), 4)
        self.assertEqual(len(validate_trace(archived_trace(ARCHIVES[1]))), 5)

    def test_suite_version_two_requires_all_seven_scenarios(self):
        self.assertEqual(validate_trace(synthetic_suite()), SCENARIOS)
        data = archived_trace(ARCHIVES[1])
        data["suite_version"] = 2
        with self.assertRaisesRegex(ValueError, "scenario summaries"):
            validate_trace(data)

    def test_protocol_faults_recover_or_remain_contained(self):
        for name in ("replay", "wrong_generation"):
            for contained in (False, True):
                with self.subTest(scenario=name, contained=contained):
                    self.assertEqual(validate_trace(synthetic_single(name, contained)), (name,))

    def test_rejection_must_demonstrate_the_actual_protocol_fault(self):
        changes = (
            ("replay", {"seq": 8}),
            ("replay", {"received_generation": 0}),
            ("replay", {"reason": "command_range"}),
            ("wrong_generation", {"received_generation": 1}),
            ("wrong_generation", {"received_generation": False}),
            ("wrong_generation", {"proposed_output": 999}),
            ("wrong_generation", {"output": 20}),
            ("wrong_generation", {"state": "running"}),
        )
        for name, fields in changes:
            with self.subTest(scenario=name, fields=fields):
                data = synthetic_single(name)
                event_named(data, "rejected", name).update(fields)
                with self.assertRaises(ValueError):
                    validate_trace(data)
        data = synthetic_single("wrong_generation")
        del event_named(data, "rejected", "wrong_generation")["received_generation"]
        with self.assertRaises(ValueError):
            validate_trace(data)

    def test_success_and_adjusted_counters_cannot_replace_observed_rejection(self):
        data = synthetic_single("replay")
        data["events"] = [event for event in data["events"] if event["event"] != "rejected"]
        summary_named(data, "replay")["rejected"] = 0
        event_named(data, "summary", "replay")["rejected"] = 0
        with self.assertRaisesRegex(ValueError, "missing injected-message rejection"):
            validate_trace(data)

    def test_numeric_values_cannot_masquerade_as_native_integer_fields(self):
        changes = (
            ("summary", "healthy", {"accepted": 12.0}),
            ("summary", "crash", {"restarts": True}),
            ("summary", "crash", {"injection_observed": 1}),
            ("proposal", "healthy", {"seq": True}),
            ("proposal", "healthy", {"proposed_output": 27.0}),
            ("proposal", "healthy", {"t_ms": True}),
            ("proposal", "healthy", {"t_ms": float("inf")}),
            ("worker_exit", "crash", {"exit_code": 42.0}),
            ("worker_exit", "crash", {"signal": False}),
        )
        for kind, name, fields in changes:
            with self.subTest(event=kind, fields=fields):
                data = synthetic_suite()
                event_named(data, kind, name).update(fields)
                if kind == "summary":
                    summary_named(data, name).update(fields)
                with self.assertRaises(ValueError):
                    validate_trace(data)

    def test_report_summary_must_match_event_summary_including_types(self):
        data = synthetic_suite()
        event_named(data, "summary", "crash")["passed"] = 1
        with self.assertRaisesRegex(ValueError, "inconsistent scenario trace"):
            validate_trace(data)

    def test_sequence_validation_restart_and_lockout_mutations_are_rejected(self):
        changes = (
            ("proposal", "healthy", {"seq": 2}),
            ("proposal", "healthy", {"state": "running", "output": 27}),
            ("proposal", "healthy", {"output": 999}),
            ("worker_exit", "crash", {"exit_code": 41}),
            ("hold", "stall", {"reason": "worker_crash"}),
            ("rejected", "invalid", {"proposed_output": 60}),
            ("rejected", "invalid", {"received_generation": 0}),
            ("restart", "crash", {"generation": 1}),
            ("locked_out", "crash_loop", {"output": 20}),
            ("summary", "crash_loop", {"holds": 2}),
            ("summary", "crash", {"recovery_delay_ms": 0}),
        )
        for kind, name, fields in changes:
            with self.subTest(event=kind, fields=fields):
                data = synthetic_suite()
                event_named(data, kind, name).update(fields)
                if kind == "summary":
                    summary_named(data, name).update(fields)
                with self.assertRaises(ValueError):
                    validate_trace(data)
        data = synthetic_single("replay", contained=True)
        proposal = copy.deepcopy(event_named(data, "proposal", "replay"))
        proposal.update(t_ms=data["events"][-1]["t_ms"], seq=4, state="running", output=27)
        data["events"].insert(-2, proposal)
        with self.assertRaises(ValueError):
            validate_trace(data)

    def test_malformed_reports_raise_validation_errors(self):
        malformed = [None, [], {}, {"environment": {}, "events": None, "scenarios": []}]
        for field, value in (("suite_version", True), ("suite_version", 3), ("config", None),
                             ("events", [None]), ("scenarios", [{"scenario": 1}])):
            data = synthetic_suite()
            data[field] = value
            malformed.append(data)
        data = synthetic_suite()
        del event_named(data, "proposal", "healthy")["seq"]
        malformed.append(data)
        data = synthetic_suite()
        event_named(data, "proposal", "healthy")["event"] = []
        malformed.append(data)
        for data in malformed:
            with self.subTest(report=data if not isinstance(data, dict) else list(data)):
                with self.assertRaises(ValueError):
                    validate_trace(data)


if __name__ == "__main__":
    unittest.main()
