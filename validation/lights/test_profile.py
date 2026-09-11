import unittest

from validation.lights.profile import inverse_response


class ProfileTests(unittest.TestCase):
    def test_linear_measurements_produce_identity_inverse(self):
        rows = [
            {"channel": channel, "drive": str(drive), "light": str(3 + drive * 2)}
            for channel in "rgb"
            for drive in range(256)
        ]
        self.assertEqual(inverse_response(rows), [[i / 16 for i in range(17)]] * 3)
        rows[100]["light"] = "1"
        with self.assertRaises(ValueError):
            inverse_response(rows)

    def test_missing_channel_and_nonfinite_measurements_fail(self):
        for bad in [
            [],
            [{"channel": "r", "drive": str(i), "light": "nan"} for i in range(256)],
        ]:
            with self.assertRaises(ValueError):
                inverse_response(bad)


if __name__ == "__main__":
    unittest.main()
