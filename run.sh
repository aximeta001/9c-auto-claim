#!/usr/bin/env bash
# 定时任务入口：执行一次「检查 + 领取」，结果写入 claim.log
# 由 WorkBuddy 定时任务调用：bash /workspace/9c-auto-claim/run.sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

LOG="$DIR/claim.log"
LOCK="$DIR/.claim.lock"

# 防止上一次没跑完时重复触发（flock 若不可用则退化为无锁）
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "$(date -Is) SKIP 上一次执行尚未结束" >> "$LOG"
    exit 0
  fi
fi

# 日志只保留最近 2000 行
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ]; then
  tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

echo "===== $(date -Is) run =====" >> "$LOG"
node "$DIR/claim.mjs" "$@" >> "$LOG" 2>&1
CODE=$?
echo "===== $(date -Is) exit=$CODE =====" >> "$LOG"
exit $CODE
