CREATE TABLE "experiment_ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"issue_id" uuid,
	"proposing_agent_id" uuid,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"expected_direction" text DEFAULT 'improve' NOT NULL,
	"family" text,
	"patch_format" text DEFAULT 'unified_diff' NOT NULL,
	"patch_body" text NOT NULL,
	"based_on_sha" text,
	"predicted_val_bpb_delta" double precision,
	"scores" jsonb NOT NULL,
	"score_total" double precision DEFAULT 0 NOT NULL,
	"critic_score" double precision,
	"status" text DEFAULT 'proposed' NOT NULL,
	"rejection_reason" text,
	"decided_by_type" text,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"verdict_reason" text NOT NULL,
	"previous_best_val_bpb" double precision,
	"new_best_val_bpb" double precision,
	"git_action" text NOT NULL,
	"target_sha" text,
	"reason" text,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"issue_id" uuid,
	"idea_id" uuid,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"hypothesis" text,
	"git_sha" text,
	"heartbeat_run_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"verdict" text,
	"verdict_reason" text,
	"metric_credit" boolean DEFAULT false NOT NULL,
	"complexity_delta_lines" integer,
	"val_bpb" double precision,
	"delta_vs_best_at_time" double precision,
	"peak_vram_mb" double precision,
	"memory_gb" double precision,
	"training_seconds" double precision,
	"total_seconds" double precision,
	"preflight_seconds" double precision,
	"eval_seconds" double precision,
	"mfu_percent" double precision,
	"total_tokens_m" double precision,
	"num_steps" integer,
	"num_params_m" double precision,
	"depth" integer,
	"train_batch_size" integer,
	"eval_batch_size" integer,
	"activation_checkpointing" boolean,
	"dataset" text,
	"autotune_cold" boolean DEFAULT false NOT NULL,
	"autotune_selected_batch_size" integer,
	"metrics_json" jsonb,
	"provenance" jsonb,
	"attestation" jsonb,
	"log_ref" text,
	"error_excerpt" text,
	"checkpoint_path" text,
	"checkpoint_bytes" bigint,
	"checkpoint_retained" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"adjudicated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"execution_workspace_id" uuid,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"branch_name" text NOT NULL,
	"base_ref" text NOT NULL,
	"repo_path" text NOT NULL,
	"protocol_document_id" uuid,
	"protocol_revision" integer,
	"status" text DEFAULT 'setup' NOT NULL,
	"gpu_profile_json" jsonb,
	"venv_path" text,
	"cache_dir" text,
	"time_budget_sec" integer DEFAULT 300 NOT NULL,
	"kill_after_sec" integer DEFAULT 600 NOT NULL,
	"is_baseline_required" boolean DEFAULT true NOT NULL,
	"baseline_val_bpb" double precision,
	"baseline_git_sha" text,
	"baseline_source" text,
	"baseline_note" text,
	"noise_floor_bpb" double precision,
	"best_val_bpb" double precision,
	"best_experiment_id" uuid,
	"target_val_bpb" double precision,
	"experiment_count" integer DEFAULT 0 NOT NULL,
	"keep_count" integer DEFAULT 0 NOT NULL,
	"discard_count" integer DEFAULT 0 NOT NULL,
	"crash_count" integer DEFAULT 0 NOT NULL,
	"consecutive_crashes" integer DEFAULT 0 NOT NULL,
	"consecutive_discards" integer DEFAULT 0 NOT NULL,
	"last_kept_sha" text,
	"last_activity_at" timestamp with time zone,
	"results_tsv_path" text,
	"keep_last_n_keeps" integer DEFAULT 3 NOT NULL,
	"explore_every_n" integer DEFAULT 4 NOT NULL,
	"min_open_ideas" integer DEFAULT 4 NOT NULL,
	"max_crash_retries_per_idea" integer DEFAULT 2 NOT NULL,
	"max_simplification_keeps_per_window" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"concluded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "gpu_seconds" integer;--> statement-breakpoint
ALTER TABLE "experiment_ideas" ADD CONSTRAINT "experiment_ideas_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_ideas" ADD CONSTRAINT "experiment_ideas_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_ideas" ADD CONSTRAINT "experiment_ideas_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_ideas" ADD CONSTRAINT "experiment_ideas_proposing_agent_id_agents_id_fk" FOREIGN KEY ("proposing_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_verdicts" ADD CONSTRAINT "experiment_verdicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_verdicts" ADD CONSTRAINT "experiment_verdicts_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_verdicts" ADD CONSTRAINT "experiment_verdicts_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_idea_id_experiment_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."experiment_ideas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studies" ADD CONSTRAINT "studies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studies" ADD CONSTRAINT "studies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studies" ADD CONSTRAINT "studies_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studies" ADD CONSTRAINT "studies_protocol_document_id_documents_id_fk" FOREIGN KEY ("protocol_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studies" ADD CONSTRAINT "studies_best_experiment_id_experiments_id_fk" FOREIGN KEY ("best_experiment_id") REFERENCES "public"."experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experiment_ideas_study_status_idx" ON "experiment_ideas" USING btree ("study_id","status");--> statement-breakpoint
CREATE INDEX "experiment_ideas_study_score_total_idx" ON "experiment_ideas" USING btree ("study_id","score_total");--> statement-breakpoint
CREATE INDEX "experiment_ideas_proposing_agent_idx" ON "experiment_ideas" USING btree ("proposing_agent_id");--> statement-breakpoint
CREATE INDEX "experiment_verdicts_study_created_idx" ON "experiment_verdicts" USING btree ("study_id","created_at");--> statement-breakpoint
CREATE INDEX "experiment_verdicts_experiment_idx" ON "experiment_verdicts" USING btree ("experiment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_study_sequence_uq" ON "experiments" USING btree ("study_id","sequence");--> statement-breakpoint
CREATE INDEX "experiments_study_val_bpb_idx" ON "experiments" USING btree ("study_id","val_bpb");--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_single_running_per_study" ON "experiments" USING btree ("study_id") WHERE "experiments"."status" = 'running';--> statement-breakpoint
CREATE INDEX "experiments_study_verdict_idx" ON "experiments" USING btree ("study_id","verdict");--> statement-breakpoint
CREATE INDEX "experiments_company_heartbeat_run_idx" ON "experiments" USING btree ("company_id","heartbeat_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "studies_company_tag_uq" ON "studies" USING btree ("company_id","tag");--> statement-breakpoint
CREATE INDEX "studies_company_status_idx" ON "studies" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "studies_company_last_activity_idx" ON "studies" USING btree ("company_id","last_activity_at");