CREATE TYPE "public"."check_outcome" AS ENUM('unchanged', 'changed', 'changed_no_alert', 'stale', 'blocked', 'error');--> statement-breakpoint
CREATE TYPE "public"."check_interval" AS ENUM('30m', '1h', '1d');--> statement-breakpoint
CREATE TYPE "public"."llm_purpose" AS ENUM('rule', 'judge', 'relocate');--> statement-breakpoint
CREATE TYPE "public"."monitor_status" AS ENUM('active', 'paused', 'paused_error', 'stale');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('queued', 'sent', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'paid');--> statement-breakpoint
CREATE TYPE "public"."rule_author" AS ENUM('llm', 'user');--> statement-breakpoint
CREATE TYPE "public"."snapshot_kind" AS ENUM('latest', 'previous');--> statement-breakpoint
CREATE TABLE "changes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"monitor_id" text NOT NULL,
	"check_id" text,
	"old_value" text,
	"new_value" text,
	"summary" text,
	"alerted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"monitor_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "check_outcome",
	"http_status" integer,
	"fetch_ms" integer,
	"observed_value" text,
	"text_hash" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text,
	"monitor_id" text,
	"purpose" "llm_purpose" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_codes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"salt" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"monitor_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"url" text NOT NULL,
	"host" text NOT NULL,
	"title" text,
	"favicon_url" text,
	"status" "monitor_status" DEFAULT 'active' NOT NULL,
	"interval" "check_interval" DEFAULT '1h' NOT NULL,
	"daily_at" integer,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_outcome" "check_outcome",
	"last_alert_at" timestamp with time zone,
	"last_value" text,
	"previous_value" text,
	"needs_browser" boolean DEFAULT false NOT NULL,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"consecutive_blocks" integer DEFAULT 0 NOT NULL,
	"etag" text,
	"last_modified" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"monitor_id" text,
	"template" text NOT NULL,
	"body" text,
	"twilio_sid" text,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "previews" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"url" text NOT NULL,
	"host" text NOT NULL,
	"title" text,
	"favicon_url" text,
	"readable_text" text NOT NULL,
	"html" text NOT NULL,
	"http_status" integer,
	"fetch_status" text NOT NULL,
	"etag" text,
	"last_modified" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"monitor_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"json" jsonb NOT NULL,
	"summary" text NOT NULL,
	"confidence" real,
	"created_by" "rule_author" DEFAULT 'llm' NOT NULL,
	"approved_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"monitor_id" text NOT NULL,
	"kind" "snapshot_kind" NOT NULL,
	"readable_text" text NOT NULL,
	"html" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"phone_e164" text NOT NULL,
	"country_code" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"quiet_hours_start" integer,
	"quiet_hours_end" integer,
	"whatsapp_opted_out" boolean DEFAULT false NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_codes" ADD CONSTRAINT "login_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_tokens" ADD CONSTRAINT "magic_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "changes_monitor_idx" ON "changes" USING btree ("monitor_id","created_at");--> statement-breakpoint
CREATE INDEX "checks_monitor_idx" ON "checks" USING btree ("monitor_id","started_at");--> statement-breakpoint
CREATE INDEX "llm_calls_user_idx" ON "llm_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "login_codes_user_idx" ON "login_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "magic_tokens_user_idx" ON "magic_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "monitors_due_idx" ON "monitors" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "monitors_user_idx" ON "monitors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_sid_idx" ON "notifications" USING btree ("twilio_sid");--> statement-breakpoint
CREATE INDEX "previews_user_idx" ON "previews" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "rules_monitor_idx" ON "rules" USING btree ("monitor_id","active");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshots_monitor_kind_idx" ON "snapshots" USING btree ("monitor_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_idx" ON "users" USING btree ("phone_e164");