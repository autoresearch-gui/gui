ALTER TABLE "experiments" ADD COLUMN "transient_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "transient_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "max_transient_retries" integer DEFAULT 3 NOT NULL;