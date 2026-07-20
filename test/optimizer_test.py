import unittest

from scripts.optimize import parse_json, partition_cases, replay_score


class OptimizerHelpersTest(unittest.TestCase):
    def test_parses_fenced_json(self):
        self.assertEqual(parse_json('```json\n{"value": 1}\n```'), {"value": 1})

    def test_replay_score_penalizes_false_positives(self):
        candidate = {"optimizedKeywords": ["unicode", "nfc", "username"]}
        cases = [
            {"prompt": "Normalize Unicode username to NFC", "expectedRelevant": True},
            {"prompt": "Sort graph nodes", "expectedRelevant": False},
        ]
        score, false_positive_rate = replay_score(candidate, cases)
        self.assertEqual(score, 1.0)
        self.assertEqual(false_positive_rate, 0.0)

    def test_requires_independent_train_validation_and_test_splits(self):
        candidate = {"id": "candidate", "cases": [{"split": "train"}, {"split": "validation"}]}
        with self.assertRaisesRegex(ValueError, "non-empty train, validation, and test"):
            partition_cases(candidate)


if __name__ == "__main__":
    unittest.main()
