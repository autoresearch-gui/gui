CREATE TABLE "study_proposers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_proposal_at" timestamp with time zone,
	"proposal_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "executor_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "pulse_interval_sec" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "studies" ADD COLUMN "last_pulse_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "study_proposers" ADD CONSTRAINT "study_proposers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_proposers" ADD CONSTRAINT "study_proposers_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_proposers" ADD CONSTRAINT "study_proposers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "study_proposers_study_agent_uq" ON "study_proposers" USING btree ("study_id","agent_id");--> statement-breakpoint
CREATE INDEX "study_proposers_study_active_idx" ON "study_proposers" USING btree ("study_id","active");--> statement-breakpoint
CREATE INDEX "study_proposers_study_last_asked_idx" ON "study_proposers" USING btree ("study_id","last_proposal_at");--> statement-breakpoint
ALTER TABLE "studies" ADD CONSTRAINT "studies_executor_agent_id_agents_id_fk" FOREIGN KEY ("executor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;