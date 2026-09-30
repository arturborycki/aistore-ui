"""Append N synthetic rows to a table created by the live write test.

Guarded: only tables in edw1.scratch whose name starts with `uitest_` are
accepted, so it can never write into existing data. Credentials come from the
standard AWS_* environment variables (PyIceberg's SigV4 signer uses them).

  LIVE_S3_ENDPOINT=http://<aistor-host>:<s3-port> python append.py <table> <rows>
"""
import datetime, decimal, os, sys

import pyarrow as pa
from pyiceberg.catalog import load_catalog
from pyiceberg.types import (BooleanType, DateType, DecimalType, DoubleType, FloatType, IntegerType, LongType,
                             StringType, TimestampType, TimestamptzType)

table_name, rows = sys.argv[1], int(sys.argv[2])
endpoint = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("LIVE_S3_ENDPOINT", "")
if not endpoint:
    sys.exit("set LIVE_S3_ENDPOINT to the AIStor S3 API, e.g. http://<aistor-host>:<s3-port>")
if not table_name.startswith("uitest_"):
    sys.exit("refusing to write: only uitest_* tables may be written")

key, secret = os.environ["AWS_ACCESS_KEY_ID"], os.environ["AWS_SECRET_ACCESS_KEY"]
cat = load_catalog("aistor", **{
    "type": "rest", "uri": f"{endpoint}/_iceberg", "warehouse": os.environ.get("LIVE_WAREHOUSE", "edw1"),
    "rest.sigv4-enabled": "true", "rest.signing-name": "s3tables", "rest.signing-region": "us-east-1",
    "s3.endpoint": endpoint, "s3.access-key-id": key, "s3.secret-access-key": secret,
    "s3.region": "us-east-1", "s3.path-style-access": "true",
})
tbl = cat.load_table(("scratch", table_name))
now = datetime.datetime.now(datetime.timezone.utc)
start = len(tbl.scan().to_arrow()) if tbl.current_snapshot() else 0

def column(f, n):
    t = f.field_type
    rng = range(start, start + n)
    if isinstance(t, (LongType, IntegerType)): return [i + 1 for i in rng]
    if isinstance(t, (DoubleType, FloatType)): return [i * 1.5 for i in rng]
    if isinstance(t, DecimalType): return [decimal.Decimal(i).scaleb(-t.scale) + decimal.Decimal(10) for i in rng]
    if isinstance(t, StringType): return [f"{f.name}-{i}" for i in rng]
    if isinstance(t, BooleanType): return [i % 2 == 0 for i in rng]
    if isinstance(t, TimestamptzType): return [now - datetime.timedelta(hours=i) for i in rng]
    if isinstance(t, TimestampType): return [(now - datetime.timedelta(hours=i)).replace(tzinfo=None) for i in rng]
    if isinstance(t, DateType): return [(now - datetime.timedelta(days=i)).date() for i in rng]
    return [None] * n

schema = tbl.schema().as_arrow()
data = pa.Table.from_pydict({f.name: column(f, rows) for f in tbl.schema().fields}, schema=schema)
tbl.append(data)
tbl = cat.load_table(("scratch", table_name))
print(f"appended {rows} rows to scratch.{table_name}; snapshot {tbl.current_snapshot().snapshot_id}")
