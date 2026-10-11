#!/usr/bin/env bash
# ============================================================================
# Live proof of the DELETE path against the real project (todo-students-sync).
#
# WHY THIS EXISTS
#   The unit tests use a fake transport, so they cannot tell whether the real
#   server accepts the tombstone our client sends. This was written after
#   finding that `flushOutbox` was sending deletes as `DELETE /tasks?id=eq.X` —
#   a call the server answers with 204 OK even when RLS makes it delete ZERO
#   rows, and which is invisible to every other device.
#
# SCOPE
#   Runs ONLY against shvmockjugpstullgpcv. Never point this at another project
#   (MELLORA znomcchqodlzgsbayuoo is off limits). Creates one throwaway row and
#   removes it at the end. Re-runnable.
#
# The anon key below is PUBLIC BY DESIGN (it ships in the client bundle); RLS is
# the protection, not secrecy. No service_role and no user token is stored here.
# ============================================================================
set -u
URL="https://shvmockjugpstullgpcv.supabase.co"
ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNodm1vY2tqdWdwc3R1bGxncGN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3NTAxMDcsImV4cCI6MjEwNzMyNjEwN30.P5Ezjhh6pImWs2y1FACBihS9dGi0DF9P_6W2Ro1BMIo"

signin() { # $1 = email
  curl -s -X POST "$URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1\",\"password\":\"Test-RLS-Phase2!\"}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}

# tokens stay in variables; nothing prints them
TOKEN=$(signin rls-a@example.com)
TOKENB=$(signin rls-b@example.com)
[ -z "$TOKEN" ] && { echo "FAIL: could not sign in (are the temp rls-a/rls-b users still seeded?)"; exit 1; }
echo "signed in: rls-a + rls-b (tokens held in variables, never printed)"

A=$(python -c "import uuid;print(uuid.uuid4())")
del_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
h() { curl -s -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" "$@"; }

echo
echo "1) push a normal row (revision 1)"
h -X POST "$URL/rest/v1/rpc/push_tasks" -H "Content-Type: application/json" \
  -d "{\"batch\":[{\"id\":\"$A\",\"title\":\"live delete probe\",\"subject\":\"\",\"priority\":\"normal\",\"done\":false,\"revision\":1}]}"

echo
echo "2) it is visible to a pull:"
h "$URL/rest/v1/tasks?select=title,revision,deleted_at&id=eq.$A"

echo
echo "3) push the TOMBSTONE exactly as the client now does (revision bumped + deleted_at)"
h -X POST "$URL/rest/v1/rpc/push_tasks" -H "Content-Type: application/json" \
  -d "{\"batch\":[{\"id\":\"$A\",\"title\":\"live delete probe\",\"subject\":\"\",\"priority\":\"normal\",\"done\":false,\"revision\":2,\"deleted_at\":\"$del_at\"}]}"

echo
echo "4) THE POINT: the row SURVIVES with deleted_at set, so another device can pull the delete"
h "$URL/rest/v1/tasks?select=title,revision,deleted_at&id=eq.$A"

echo
echo "5) the delta pull a second device runs sees it as a tombstone"
h "$URL/rest/v1/tasks?select=id,deleted_at&deleted_at=not.is.null"

echo
echo "6) anon gets nothing"
curl -s -o /dev/null -w "   anon pull -> HTTP %{http_code}\n" \
  "$URL/rest/v1/tasks?select=id" -H "apikey: $ANON"

echo
echo "7) RLS still holds — B cannot see it, and B's DELETE must NOT remove A's row"
echo -n "   B GET  -> "; curl -s -H "apikey: $ANON" -H "Authorization: Bearer $TOKENB" \
  "$URL/rest/v1/tasks?select=id&id=eq.$A"; echo
echo -n "   B DELETE -> "; curl -s -o /dev/null -w "HTTP %{http_code}" -X DELETE \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOKENB" "$URL/rest/v1/tasks?id=eq.$A"
echo "   <- 204 even though it deleted 0 rows: why a hard DELETE is untrustworthy"
echo -n "   row afterwards -> "; h "$URL/rest/v1/tasks?select=revision,deleted_at&id=eq.$A"; echo

echo
echo "8) cleanup"
curl -s -o /dev/null -w "   delete -> HTTP %{http_code}\n" -X DELETE \
  -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" "$URL/rest/v1/tasks?id=eq.$A"

# curl can report a write error on the -o /dev/null calls; the checks above are
# the result, so a non-zero exit here would be misleading.
exit 0
