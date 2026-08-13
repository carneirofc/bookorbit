ALTER TABLE "book_dock_files" ADD COLUMN "sha256" varchar(64);--> statement-breakpoint
CREATE INDEX "book_dock_files_sha256_idx" ON "book_dock_files" USING btree ("sha256");