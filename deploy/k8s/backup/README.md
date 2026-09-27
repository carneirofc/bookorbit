# BookOrbit backup manifests (Kubernetes)

Example manifests for backing up and restoring BookOrbit with [restic](https://restic.net) to an S3-compatible object store. They do not depend on any Postgres operator.

| File                      | Purpose                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `secret.example.yaml`     | Restic repository, S3 credentials and `DATABASE_URL`                      |
| `restic-init-job.yaml`    | One-time repository initialization                                        |
| `backup-cronjob.yaml`     | Nightly database dump plus `/books` and `/data` snapshots, with retention |
| `restore-db-job.yaml`     | Restores the database into an empty target database                       |
| `restore-files-job.yaml`  | Restores the books and app data PVCs                                      |
| `restic-toolbox-pod.yaml` | Pod for ad hoc `restic` commands                                          |

The namespace (`bookorbit`), PVC names (`bookorbit-books`, `bookorbit-data`) and the app pod label (`app.kubernetes.io/name: bookorbit`) are placeholders. Adjust them to match your deployment.

The full procedure, including migration to a new installation, is in [docs/BACKUP_AND_RESTORE.md](../../../docs/BACKUP_AND_RESTORE.md).
