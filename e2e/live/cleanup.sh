#!/usr/bin/env bash
# Drops (with purge) every uitest_* table and view in LIVE_WAREHOUSE.LIVE_NS and
# deletes uitest_* semantic models, through the UI's API. Never touches anything else.
set -euo pipefail
BASE=${E2E_BASE_URL:-http://localhost:8080}; C=${LIVE_CLUSTER:-lab}; WH=${LIVE_WAREHOUSE:-edw1}; NS=${LIVE_NS:-scratch}
J=$(mktemp); trap 'rm -f $J' EXIT
H=(-H 'Content-Type: application/json' -H "Origin: $BASE")
curl -sf -c $J -b $J "${H[@]}" -X POST $BASE/auth/builtin/login -d "{\"accessKey\":\"$LIVE_ACCESS_KEY\",\"secretKey\":\"$LIVE_SECRET_KEY\"}" -o /dev/null
csrf() { curl -sf -c $J -b $J "${H[@]}" -H "X-CSRF-Token: $(curl -sf -b $J $BASE/auth/me | python3 -c 'import json,sys;print(json.load(sys.stdin)["csrfToken"])')" -X POST $BASE/auth/step-up -d "{\"secret\":\"$LIVE_SECRET_KEY\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["csrfToken"])'; }
T=$(csrf)
A=$BASE/api/c/$C/wh/$WH/ns/$NS
for v in $(curl -sf -b $J "$A/views?pageSize=1000" | python3 -c 'import json,sys;print(" ".join(i["name"] for i in json.load(sys.stdin).get("identifiers",[]) if i["name"].startswith("uitest_")))'); do
  echo "drop view $v: $(curl -s -b $J "${H[@]}" -H "X-CSRF-Token: $T" -X DELETE "$A/v/$v" -o /dev/null -w '%{http_code}')"
done
for t in $(curl -sf -b $J "$A/tables?pageSize=1000" | python3 -c 'import json,sys;print(" ".join(i["name"] for i in json.load(sys.stdin)["identifiers"] if i["name"].startswith("uitest_")))'); do
  echo "drop table $t (purge): $(curl -s -b $J "${H[@]}" -H "X-CSRF-Token: $T" -X DELETE "$A/t/$t?purge=true" -o /dev/null -w '%{http_code}')"
done
M=$BASE/api/c/$C/semantic/wh/$WH/ns/$NS/models
for m in $(curl -s -b $J "$M" | python3 -c 'import json,sys;print(" ".join(x["name"] for x in json.load(sys.stdin).get("models",[]) if x["name"].startswith("uitest_")))' 2>/dev/null); do
  E=$(curl -sf -b $J "$M/$m" | python3 -c 'import json,sys;print(json.load(sys.stdin)["etag"])')
  echo "delete model $m: $(curl -s -b $J "${H[@]}" -H "X-CSRF-Token: $T" -H "If-Match: $E" -X DELETE "$M/$m" -o /dev/null -w '%{http_code}')"
done
