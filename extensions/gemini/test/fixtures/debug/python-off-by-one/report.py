# ---------------------------------------------------------------------------------------------
#  Copyright (c) Pulkit Jain. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------

# A sample program for Debug mode in the real app (DEBUG_MODE.md, Testing):
# a weekly report with an off-by-one. It should list the last N days of
# sales, newest first, but leaves out the newest day.
#
#   python3 report.py 3    prints the last 3 days and exits 1 while the bug is there

import sys

SALES = [
	("2026-10-25", 120),
	("2026-10-26", 95),
	("2026-10-27", 143),
	("2026-10-28", 88),
	("2026-10-29", 101),
	("2026-10-30", 132),
	("2026-10-31", 77),
]


def last_days(days, n):
	# The bug: the slice stops one short of the end, so the newest day is lost.
	window = days[len(days) - n - 1:len(days) - 1]
	return list(reversed(window))


def main(argv):
	n = int(argv[1]) if len(argv) > 1 else 3
	rows = last_days(SALES, n)
	for day, amount in rows:
		print(f"{day}  {amount}")
	newest = SALES[-1][0]
	return 0 if rows and rows[0][0] == newest else 1


if __name__ == "__main__":
	sys.exit(main(sys.argv))
