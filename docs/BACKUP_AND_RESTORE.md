# Backup, Restore and Migration (Kubernetes)

This runbook covers backing up a BookOrbit installation on Kubernetes, restoring it after a failure, and migrating it to a new installation (another namespace or cluster). The example manifests live in [`deploy/k8s/backup/`](../deploy/k8s/backup/).

It assumes:

- BookOrbit runs as a Deployment with two PVCs: books mounted at `/books` and app data mounted at `/data`.
- PostgreSQL runs in the cluster and is reachable through a Service. No specific operator is assumed; only `pg_dump` and `pg_restore` are used.
- Backups go to an S3-compatible object store (MinIO, Garage, AWS S3, Backblaze B2, ...).

Backups use [restic](https://restic.net): encrypted, deduplicated and incremental, so nightly backups of a library with tens of thousands of books only upload what changed.

## 1. What gets backed up

| State    | Where             | Backed up as                                  | Notes                                                                                                                                                                       |
| -------- | ----------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database | PostgreSQL        | `pg_dump` custom-format file, restic tag `db` | Users, libraries, metadata, reading progress, annotations, Kobo and KOReader state, OIDC and SMTP settings.                                                                 |
| Books    | `/books` PVC      | restic tag `books`                            | The book files themselves.                                                                                                                                                  |
| App data | `/data` PVC       | restic tag `data`                             | Covers (`covers/`), author images (`authors/`), avatars (`users/`), custom fonts (`fonts/`), custom icons (`icons/`), and the Book Dock upload staging area (`book-dock/`). |
| Secrets  | Kubernetes Secret | Out of band (section 4)                       | Not stored in restic.                                                                                                                                                       |

Deliberately excluded:

- `/data/.uploads/`: in-progress chunked upload sessions. They are temporary and clients retry them.
- `/tmp`: scratch space.

### Things that must stay the same on the target

- **Mount paths `/books` and `/data`.** The database stores absolute file paths (`book_files.absolute_path`, `books.folder_path`, `library_folders.path`, `book_dock_files.absolute_path`). If a path changes, books show up as missing. If you set `APP_DATA_PATH` or `BOOK_DOCK_PATH`, keep the same values.
- **`EMAIL_ENCRYPTION_KEY` and `MIGRATION_ENCRYPTION_KEY`.** SMTP provider credentials and migration-source credentials are stored in the database encrypted with these keys. With different keys they cannot be decrypted and must be re-entered.
- **`APP_URL`.** Kobo devices, OPDS clients and the KOReader plugin are configured with it. If the public URL changes, re-pair those devices.
- **App image version: the same or newer, never older.** BookOrbit applies schema migrations automatically at startup. An older image cannot run against a database migrated by a newer one.

`JWT_SECRET` can change: the only effect is that everyone has to log in again. Keeping it avoids that.

## 2. Prerequisites and one-time setup

1. Create an S3 bucket (for example `bookorbit-backups`) and an access key limited to that bucket.
2. Generate a restic repository password and store it in your password manager:

   ```sh
   openssl rand -base64 32
   ```

3. Fill in and apply the backup Secret:

   ```sh
   cp deploy/k8s/backup/secret.example.yaml secret.yaml
   # edit secret.yaml: RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_*, DATABASE_URL
   kubectl apply -f secret.yaml
   ```

4. Adjust placeholders in the manifests to match your deployment: namespace (`bookorbit`), PVC names (`bookorbit-books`, `bookorbit-data`) and the app pod label used by `podAffinity` (`app.kubernetes.io/name: bookorbit`).
5. Initialize the repository:

   ```sh
   kubectl apply -f deploy/k8s/backup/restic-init-job.yaml
   kubectl -n bookorbit logs -f job/bookorbit-restic-init
   ```

## 3. Routine backups

```sh
kubectl apply -f deploy/k8s/backup/backup-cronjob.yaml
```

Each run:

1. Dumps the database with `pg_dump --format=custom` into a temporary volume.
2. Uploads the dump (`--tag db`), then `/books` (`--tag books`), then `/data` without `.uploads` (`--tag data`).
3. Applies retention: 7 daily, 4 weekly and 6 monthly snapshots, then prunes unused data.

The database is dumped first. A book or cover added while the file backup runs may be present on disk without a database row; the next library scan picks up such books. The reverse (a row without its file) cannot happen for files that already existed at dump time.

The PVCs are mounted read-only and the job is scheduled next to the app pod, so `ReadWriteOnce` volumes work. `ReadWriteOncePod` volumes cannot be shared: scale the app to 0 around the backup in that case.

### Run a backup now

```sh
kubectl -n bookorbit create job --from=cronjob/bookorbit-backup bookorbit-backup-manual-$(date +%s)
kubectl -n bookorbit logs -f job/<job-name> -c pg-dump
kubectl -n bookorbit logs -f job/<job-name> -c restic
```

### Check the backups

```sh
kubectl apply -f deploy/k8s/backup/restic-toolbox-pod.yaml
kubectl -n bookorbit exec -it bookorbit-restic-toolbox -- restic snapshots --host bookorbit
kubectl -n bookorbit exec -it bookorbit-restic-toolbox -- restic stats latest --host bookorbit --tag books
```

Once a month, check that the stored data is readable (5% of the data is downloaded and verified each time):

```sh
kubectl -n bookorbit exec -it bookorbit-restic-toolbox -- restic check --read-data-subset=5%
kubectl -n bookorbit delete pod bookorbit-restic-toolbox
```

A backup you have never restored is not proven. Do a test restore (section 6) into a scratch namespace at least once, and again after major upgrades.

## 4. Secrets escrow

Restic backups are useless without the restic password, and parts of the database are useless without the encryption keys. Keep a copy outside the cluster:

```sh
kubectl -n bookorbit get secret <bookorbit-app-secret> -o yaml > bookorbit-app-secret.yaml
kubectl -n bookorbit get secret bookorbit-backup -o yaml > bookorbit-backup-secret.yaml
```

Encrypt these files (for example with `sops` and `age`) or store the values in a password manager, then delete the plaintext copies. The values that matter:

| Value                                                 | If lost                                                 |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `RESTIC_PASSWORD`                                     | **All backups are unreadable.**                         |
| `EMAIL_ENCRYPTION_KEY`                                | Stored SMTP credentials must be re-entered.             |
| `MIGRATION_ENCRYPTION_KEY`                            | Stored migration-source credentials must be re-entered. |
| `JWT_SECRET`                                          | Users log in again.                                     |
| Database password, `SETUP_BOOTSTRAP_TOKEN`, `APP_URL` | Recreate or look them up.                               |

## 5. Restore in place (disaster recovery)

Use this when the installation still exists but the data is damaged or lost.

1. Stop the app, so nothing writes to the database or the volumes:

   ```sh
   kubectl -n bookorbit scale deployment/bookorbit --replicas=0
   ```

2. Pick the snapshots to restore:

   ```sh
   kubectl -n bookorbit exec -it bookorbit-restic-toolbox -- restic snapshots --host bookorbit
   ```

   Use the `db`, `books` and `data` snapshots from the same backup run (same date). `latest` is the default in the restore jobs.

3. Recreate the database empty. Connect as a role that can drop and create databases (the Postgres superuser, or the database owner via your operator):

   ```sql
   DROP DATABASE bookorbit WITH (FORCE);
   CREATE DATABASE bookorbit OWNER bookorbit;
   \c bookorbit
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

   Creating the extensions as a superuser here is only required if the BookOrbit role is not allowed to create them itself.

4. Restore the database:

   ```sh
   # optional: set SNAPSHOT in the manifest to a snapshot ID instead of latest
   kubectl apply -f deploy/k8s/backup/restore-db-job.yaml
   kubectl -n bookorbit logs -f job/bookorbit-restore-db -c pg-restore
   ```

   The job prints the number of books and users restored. It restores in a single transaction and stops on the first error, so a failed restore leaves the database empty rather than half-filled.

5. Restore the files. Set `RESTORE_DELETE` to `"true"` in the manifest so files added after the backup are removed and the volumes match the snapshot:

   ```sh
   kubectl apply -f deploy/k8s/backup/restore-files-job.yaml
   kubectl -n bookorbit logs -f job/bookorbit-restore-files
   ```

6. Start the app and verify (section 7):

   ```sh
   kubectl -n bookorbit scale deployment/bookorbit --replicas=1
   ```

7. Clean up the finished jobs (they are also removed automatically after 24 hours):

   ```sh
   kubectl -n bookorbit delete job bookorbit-restore-db bookorbit-restore-files
   ```

## 6. Migration to a new installation

The target can be a new namespace or a new cluster. Both installations must be able to reach the same S3 bucket.

### Preparation (days before)

- [ ] Routine backups are running and `restic check` passes.
- [ ] Secrets are in escrow (section 4).
- [ ] Record the running image tag:

  ```sh
  kubectl -n bookorbit get deployment bookorbit -o jsonpath='{.spec.template.spec.containers[0].image}'
  ```

- [ ] Record PVC sizes and the Postgres major version. The target Postgres must be the **same or a newer** major version and have the `uuid-ossp`, `pg_trgm` and `vector` extensions available (the `pgvector/pgvector:pg18` image has all three).
- [ ] If the public URL changes, plan to re-pair Kobo devices, OPDS clients and KOReader plugins.
- [ ] Optional: run a full rehearsal of the steps below into a scratch namespace, then delete it.

### Cutover

1. **Freeze the source.** Tell users about the downtime, then stop the app:

   ```sh
   kubectl -n bookorbit scale deployment/bookorbit --replicas=0
   ```

2. **Take a final backup.** With the app stopped, this snapshot is fully consistent. The job's `podAffinity` needs the app pod, so remove the `affinity` block for this run (with the app at 0 the volumes are free), or create a Job from an edited copy of the CronJob template:

   ```sh
   kubectl -n bookorbit create job --from=cronjob/bookorbit-backup bookorbit-backup-final --dry-run=client -o yaml > final-backup.yaml
   # delete spec.template.spec.affinity from final-backup.yaml
   kubectl apply -f final-backup.yaml
   kubectl -n bookorbit logs -f job/bookorbit-backup-final -c restic
   ```

   Note the three snapshot IDs printed at the end (`db`, `books`, `data`).

3. **Prepare the target** (new namespace or cluster):
   - [ ] Namespace.
   - [ ] App Secret with the **same** `EMAIL_ENCRYPTION_KEY`, `MIGRATION_ENCRYPTION_KEY` and `JWT_SECRET`. Set `APP_URL` to the new public URL if it changes.
   - [ ] Backup Secret (`bookorbit-backup`) pointing at the **same** restic repository and password, with `DATABASE_URL` pointing at the **new** database.
   - [ ] PVCs for books and data, at least as large as the source.
   - [ ] PostgreSQL with an empty `bookorbit` database and the extensions created (section 5, step 3).
   - [ ] Do **not** start the BookOrbit Deployment yet. If your manifests create it, set `replicas: 0`.

4. **Restore.** In the target namespace, set `SNAPSHOT`, `BOOKS_SNAPSHOT` and `DATA_SNAPSHOT` to the IDs from step 2, keep `RESTORE_DELETE` as `"false"` (the volumes are empty), then:

   ```sh
   kubectl apply -f deploy/k8s/backup/restore-db-job.yaml
   kubectl apply -f deploy/k8s/backup/restore-files-job.yaml
   kubectl -n bookorbit logs -f job/bookorbit-restore-db -c pg-restore
   kubectl -n bookorbit logs -f job/bookorbit-restore-files
   ```

   The two jobs are independent and can run in parallel.

5. **Start the app** with the **same image tag** as the source, with the PVCs mounted at `/books` and `/data`:

   ```sh
   kubectl -n bookorbit scale deployment/bookorbit --replicas=1
   kubectl -n bookorbit logs -f deployment/bookorbit
   ```

   Startup runs the schema migration check (nothing to apply with the same image) and fixes ownership of `/data` for the configured `PUID`/`PGID`. Upgrade to a newer image only after the migration is verified.

6. **Verify** (section 7), then switch DNS or the ingress to the new installation.

7. **Enable backups on the target**: apply `backup-cronjob.yaml` there. Both installations write to the same repository under host `bookorbit`; keep the source CronJob suspended so they do not interleave:

   ```sh
   kubectl -n bookorbit patch cronjob bookorbit-backup -p '{"spec":{"suspend":true}}'   # on the source
   ```

### Rollback

Until the new installation is signed off, the source stays intact with the app scaled to 0. To roll back, point DNS back at it and scale it to 1. Anything changed on the target after cutover is lost in a rollback.

### Decommission the source

After a sign-off period (for example two weeks), delete the source Deployment, PVCs and database. The restic snapshots taken from it stay available until retention removes them.

## 7. Verification checklist

After any restore:

- [ ] The app pod is ready and `/api/v1/health` returns 200.
- [ ] You can log in with an existing account (OIDC login works if configured).
- [ ] The number of books per library matches the source (the restore job prints the total).
- [ ] Covers, author images and avatars render.
- [ ] Reading progress, shelves and annotations are present for a few sample books.
- [ ] Opening a book in the web reader works (proves `/books` paths resolve).
- [ ] Book Dock shows the pending uploads that existed at backup time.
- [ ] Run a library scan. It should report no new books and no missing books. File inode numbers change when files are copied to a new volume; the scanner matches files by path first and updates the stored inodes.
- [ ] Settings: SMTP test email works (proves `EMAIL_ENCRYPTION_KEY` matches).
- [ ] A Kobo sync and a KOReader sync succeed.

## 8. Troubleshooting

| Symptom                                                         | Cause and fix                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restore-db` fails with `permission denied to create extension` | The app role cannot create extensions. Create `uuid-ossp`, `pg_trgm` and `vector` as a superuser in the target database first (section 5, step 3).                                                            |
| `restore-db` fails with `already exists`                        | The target database is not empty. Drop and recreate it.                                                                                                                                                       |
| `pg_dump: server version mismatch`                              | The client in the job is older than the server. Use a `postgres:<major>-alpine` image matching or newer than the server.                                                                                      |
| App crash-loops after restore with migration errors             | The image is older than the one that wrote the database. Deploy the same or a newer tag.                                                                                                                      |
| All books show as missing                                       | The books PVC is not mounted at `/books`, or the restore went to a different path. Fix the mount; see the appendix only if the path must change.                                                              |
| Permission errors writing covers or uploads                     | Restored files keep their original UID/GID. BookOrbit fixes `/data` ownership at startup unless `BOOKORBIT_FIX_PERMISSIONS=false`; otherwise run `chown -R <PUID>:<PGID> /data`, or set `fsGroup` on the pod. |
| Backup job stays `Pending`                                      | `podAffinity` found no app pod (app scaled to 0 or the label does not match), or the volume is `ReadWriteOncePod`.                                                                                            |
| SMTP or migration-source credentials fail to decrypt            | The encryption keys differ from the source. Restore them from escrow or re-enter the credentials in the admin UI.                                                                                             |

## Appendix: changing mount paths (advanced, last resort)

Only do this if the target cannot mount the books at `/books` (or data at `/data`). Run it after the database restore and **before** starting the app, as the database owner. Replace `/old/books/` and `/books/` with the old and new prefixes, keeping the trailing slash so only whole path segments match:

```sql
BEGIN;
UPDATE library_folders SET path = '/books/' || substr(path, length('/old/books/') + 1)
  WHERE path LIKE '/old/books/%';
UPDATE books SET folder_path = '/books/' || substr(folder_path, length('/old/books/') + 1)
  WHERE folder_path LIKE '/old/books/%';
UPDATE book_files SET absolute_path = '/books/' || substr(absolute_path, length('/old/books/') + 1)
  WHERE absolute_path LIKE '/old/books/%';
UPDATE library_dir_scan_state SET dir_path = '/books/' || substr(dir_path, length('/old/books/') + 1)
  WHERE dir_path LIKE '/old/books/%';
-- check the counts, then COMMIT or ROLLBACK
COMMIT;
```

A library folder that is the mount root itself (for example exactly `/old/books`) is not matched by the patterns above; update it separately. For a changed data path, apply the same pattern to `book_dock_files.absolute_path` and `book_dock_files.cover_path`. Take a fresh backup after the app is running on the new paths.
