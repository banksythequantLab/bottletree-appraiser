# Applies every migration in order to a throwaway SQLite database and reports the resulting
# schema. NOT part of the test suite and it touches nothing real - the database is in memory.
#
# Exists because `wrangler d1 execute --local` needs the workerd runtime, which does not start on
# this machine, and "it deployed without erroring" is not the same as knowing the SQL is right.
# D1 is SQLite, so plain sqlite3 validates the statements that matter - partial unique indexes,
# the ALTER TABLE ADD COLUMN forms, the 0007 table rebuild - before any of it reaches production.
#
#   python worker/tools/schema_check.py
#   python worker/tools/schema_check.py --seed   also inserts a small worked example and prints
#                                                the settlement arithmetic it produces
import sqlite3, sys, os, glob, re

HERE = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(HERE, "..", "migrations")

def apply_all(db):
    for path in sorted(glob.glob(os.path.join(MIG, "*.sql"))):
        sql = open(path, encoding="utf-8").read()
        try:
            db.executescript(sql)
            print("  ok   %s" % os.path.basename(path))
        except sqlite3.Error as e:
            print("  FAIL %s\n       %s" % (os.path.basename(path), e))
            return False
    return True

def show(db):
    print("\ntables:")
    for (name,) in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        cols = [r[1] for r in db.execute("PRAGMA table_info(%s)" % name)]
        print("  %-22s %s" % (name, ", ".join(cols)))
    print("\nindexes on the new tables:")
    for (name, tbl, sql) in db.execute(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL "
            "AND (tbl_name LIKE 'statement%' OR tbl_name IN ('items','sellers')) ORDER BY tbl_name, name"):
        print("  %-28s %s" % (name, re.sub(r"\s+", " ", sql)))

def seed(db):
    """One dealer, one sale, three sold items, 12% and $60 rent. Numbers chosen so the rounding
    is visible: 12% of 13795 is 1655.4, which must land on a whole cent and stay there."""
    db.executescript("""
      INSERT INTO users (id,email,pw_hash,pw_salt,created_at) VALUES ('u1','a@b.c','x','y','2026-03-01');
      INSERT INTO sales (id,name,status,created_at) VALUES ('s1','March','open','2026-03-01');
      INSERT INTO sellers (id,user_id,name,created_at,commission_pct,rent_cents,booth)
        VALUES ('d1','u1','Marge','2026-03-01',12.0,6000,'B12');
      INSERT INTO items (id,sale_id,seller_id,name,price_cents,status,created_at,sold_at) VALUES
        ('i1','s1','d1','Roseville vase',  6500,'sold','2026-03-01','2026-03-04'),
        ('i2','s1','d1','Griswold No 8',   4295,'sold','2026-03-01','2026-03-19'),
        ('i3','s1','d1','Crock',           3000,'sold','2026-03-01','2026-03-31'),
        ('i4','s1','d1','Unsold lamp',     9900,'available','2026-03-01',NULL),
        ('i5','s1','d1','April sale',      5000,'sold','2026-03-01','2026-04-02');
    """)
    row = db.execute("""
      SELECT COUNT(*) AS n, COALESCE(SUM(price_cents),0) AS gross
      FROM items WHERE seller_id='d1' AND status='sold'
        AND sold_at >= '2026-03-01' AND sold_at <= '2026-03-31'
    """).fetchone()
    n, gross = row[0], row[1]
    pct, rent = 12.0, 6000
    commission = round(gross * pct / 100)
    net = gross - commission - rent
    print("\nworked example - Marge, booth B12, March 2026")
    print("  items in period      %d   (the April item and the unsold lamp are correctly out)" % n)
    print("  gross                $%.2f" % (gross / 100))
    print("  commission @ %.0f%%     -$%.2f   (%.1f rounded to a whole cent)" % (pct, commission / 100, gross * pct / 100))
    print("  booth rent           -$%.2f" % (rent / 100))
    print("  net to dealer        $%.2f" % (net / 100))
    if net < 0:
        print("  NOTE net is negative - the dealer owes rent. The UI has to say that, not show a payout.")

db = sqlite3.connect(":memory:")
print("applying migrations:")
if not apply_all(db):
    sys.exit(1)
show(db)
if "--seed" in sys.argv:
    seed(db)
print("\nok")
