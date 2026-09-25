import unittest
from quota_guard import RESET, DEADLINE, permitted


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.usage = {"plan_type": "pro", "rate_limit": {"allowed": True, "limit_reached": False,
            "primary_window": {"used_percent": 70, "reset_at": RESET}}}

    def test_missing_and_changed_window(self):
        self.assertFalse(permitted({}, now=RESET - 3600))
        self.usage["rate_limit"]["primary_window"]["reset_at"] += 604800
        self.assertFalse(permitted(self.usage, now=RESET - 3600))

    def test_boundary_and_reservations(self):
        self.assertTrue(permitted(self.usage, now=RESET - 3600, outstanding=1))
        self.usage["rate_limit"]["primary_window"]["used_percent"] = 95
        self.assertFalse(permitted(self.usage, now=RESET - 3600))
        self.usage["rate_limit"]["primary_window"]["used_percent"] = 89
        self.assertFalse(permitted(self.usage, now=RESET - 3600, outstanding=2))
        self.assertFalse(permitted(self.usage, now=DEADLINE))


if __name__ == "__main__":
    unittest.main()
