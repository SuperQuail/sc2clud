cd /tmp/blindtest
python3 blindtest_write.py --json 2>&1 | tee /tmp/blindtest/run1.log | tail -n 200
exit 0
