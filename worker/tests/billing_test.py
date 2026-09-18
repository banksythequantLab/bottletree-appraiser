"""End-to-end check of the estimate metering against a local wrangler dev (D1 local). No network models needed:
APPRAISER_URL points at a dead port, so runs fail -> which also exercises the refund path."""
import time
import httpx

B = "http://127.0.0.1:8787"
c = httpx.Client(base_url=B, timeout=30)
email = f"bill{int(time.time())}@test.local"
r = c.post("/api/auth/register", json={"email": email, "password": "password123"}); assert r.status_code == 200, r.text
c.headers["cookie"] = r.headers["set-cookie"].split(";")[0]   # cookie is Secure; local dev is plain http
plan = c.get("/api/me/plan").json(); uid = plan["user_id"]
print("new user:", {k: plan[k] for k in ("plan", "credits", "can_estimate")})
assert plan["credits"] == 1 and plan["plan"] == "free"

sale = c.post("/api/sales", json={"name": "Test sale"}).json()
item = c.post(f"/api/sales/{sale['id']}/items", json={"name": "Thing"}).json()
png = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")
r = c.post(f"/api/items/{item['id']}/photos", files={"photos": ("a.png", png, "image/png")}, data={"kinds": "front"}); assert r.status_code == 200, r.text

r = c.post(f"/api/items/{item['id']}/appraise", json={}); print("appraise #1:", r.status_code, r.json().get("funded_by"))
assert r.status_code == 202 and r.json()["funded_by"] == "credit"
time.sleep(8)  # dead appraiser -> error -> refund
plan = c.get("/api/me/plan").json(); print("after failed run (refunded):", plan["credits"]); assert plan["credits"] == 1

ev = lambda **k: {"api_version": "1.0", "event": {"id": k.pop("id", f"ev{time.time_ns()}"), "app_user_id": uid, **k}}
H = {"authorization": "Bearer testsecret"}
r = c.post("/api/billing/revenuecat", json=ev(type="TEST"), headers=H); print("TEST event:", r.json())
r = c.post("/api/billing/revenuecat", json=ev(type="REFUND", product_id="estimate_1"), headers=H); print("REFUND:", r.json())
plan = c.get("/api/me/plan").json(); assert plan["credits"] == 0 and not plan["can_estimate"]
r = c.post(f"/api/items/{item['id']}/appraise", json={}); print("appraise with 0 credits:", r.status_code, r.json().get("paywall"))
assert r.status_code == 402 and r.json()["paywall"] is True

r = c.post("/api/billing/revenuecat", json=ev(id="pack1", type="NON_RENEWING_PURCHASE", product_id="estimate_10"), headers=H); print("pack:", r.json())
r = c.post("/api/billing/revenuecat", json=ev(id="pack1", type="NON_RENEWING_PURCHASE", product_id="estimate_10"), headers=H); print("pack dup:", r.json())
plan = c.get("/api/me/plan").json(); print("credits now:", plan["credits"]); assert plan["credits"] == 10

exp = int((time.time() + 30 * 86400) * 1000)
r = c.post("/api/billing/revenuecat", json=ev(type="INITIAL_PURCHASE", product_id="pro_monthly:monthly", expiration_at_ms=exp), headers=H); print("pro:", r.json())
plan = c.get("/api/me/plan").json(); print("plan:", plan["plan"], "cap", plan["monthly_cap"]); assert plan["plan"] == "pro"
r = c.post(f"/api/items/{item['id']}/appraise", json={}); assert r.status_code == 202 and r.json()["funded_by"] == "plan", r.text
time.sleep(8)
plan = c.get("/api/me/plan").json(); print("pro usage after failed run:", plan["used_this_month"], "credits untouched:", plan["credits"])
assert plan["used_this_month"] == 0 and plan["credits"] == 10

r = c.post("/api/billing/revenuecat", json=ev(type="EXPIRATION", product_id="pro_monthly:monthly"), headers=H); print("expire:", r.json())
plan = c.get("/api/me/plan").json(); assert plan["plan"] == "free" and plan["credits"] == 10
r = c.post("/api/billing/revenuecat", json=ev(type="RENEWAL", product_id="unlimited_monthly:monthly", expiration_at_ms=exp), headers=H)
plan = c.get("/api/me/plan").json(); assert plan["plan"] == "unlimited" and plan["monthly_cap"] is None
r = c.post("/api/billing/revenuecat", json=ev(type="RENEWAL", product_id="unlimited_monthly"), headers={"authorization": "Bearer wrong"}); assert r.status_code == 401
print("ALL BILLING CHECKS PASSED")


