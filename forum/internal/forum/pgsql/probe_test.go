package pgsql

import (
	"os"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	ent "forum/internal/ent"
	"forum/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestMain(m *testing.M) { testsupport.Main(m); os.Exit(0) }

func TestProbeScanShapes(t *testing.T) {
	ctx, pool := testsupport.Pool(t)
	client := ent.NewClient(ent.Driver(entSQLDriver(pool)))
	t.Cleanup(func() { _ = client.Close() })
	_ = client

	if _, err := pool.Exec(ctx, "CREATE TABLE probe (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, pid uuid NOT NULL, ts timestamptz NOT NULL, ok boolean NOT NULL, note text, arr uuid[] )"); err != nil {
		t.Fatal(err)
	}
	pid := uuid.Must(uuid.NewV7())
	now := time.Now().UTC().Truncate(time.Microsecond)
	pid2 := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, "INSERT INTO probe (pid, ts, ok, note, arr) VALUES ($1,$2,$3,$4,$5)", pid, now, true, "hi", []uuid.UUID{pid, pid2}); err != nil {
		t.Fatal(err)
	}
	// 用 ent.Client 的 QueryContext 读
	rows, err := client.QueryContext(ctx, "SELECT id, pid, ts, ok, note, arr, (SELECT count(*) FROM probe) FROM probe WHERE (ts, id) < ($1::timestamptz, $2::bigint)", time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC), int64(9223372036854775807))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id   int64
			pid  string
			ts   time.Time
			ok   bool
			note *string
			arr  any
			cnt  int64
		)
		if err := rows.Scan(&id, &pid, &ts, &ok, &note, &arr, &cnt); err != nil {
			t.Fatal(err)
		}
		t.Logf("id=%d pid=%s ts=%s ok=%v note=%v arr=%T(%v) cnt=%d", id, pid, ts.Format(time.RFC3339Nano), ok, *note, arr, arr, cnt)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	// 用 ExecContext 写，带 uuid 参数
	res, err := client.ExecContext(ctx, "UPDATE probe SET note = $1 WHERE pid = $2", "updated", pid)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := res.RowsAffected()
	t.Logf("rows affected=%d", n)

	// QueryRowContext
	r2, err := client.QueryContext(ctx, "SELECT $1::text || 'x'")
	if err != nil {
		t.Fatal(err)
	}
	defer r2.Close()
	for r2.Next() {
		var s2 string
		if err := r2.Scan(&s2); err != nil {
			t.Fatal(err)
		}
		t.Logf("r2=%s", s2)
	}

}

func entSQLDriver(pool *pgxpool.Pool) dialect.Driver {
	return entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))
}
