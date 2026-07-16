CREATE TABLE "api_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text DEFAULT 'api' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"role" text DEFAULT 'operator' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriber" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"telegram_id" bigint,
	"username" text,
	"email" text,
	"status" text DEFAULT 'active' NOT NULL,
	"marketing_opt_out" boolean DEFAULT false NOT NULL,
	"tg_blocked" boolean DEFAULT false NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriber_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"subscription_id" uuid NOT NULL,
	"hwid" text NOT NULL,
	"device_os" text,
	"os_ver" text,
	"device_model" text,
	"user_agent" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"short_uuid" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expire_at" timestamp with time zone,
	"traffic_limit_bytes" bigint,
	"traffic_limit_strategy" text DEFAULT 'month' NOT NULL,
	"used_traffic_bytes" bigint DEFAULT 0 NOT NULL,
	"lifetime_used_bytes" bigint DEFAULT 0 NOT NULL,
	"last_traffic_reset_at" timestamp with time zone,
	"hwid_device_limit" integer,
	"vless_uuid" uuid NOT NULL,
	"trojan_password" text,
	"ss_password" text,
	"sub_revoked_at" timestamp with time zone,
	"sub_last_user_agent" text,
	"sub_last_opened_at" timestamp with time zone,
	"online_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cascade_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"kind" text NOT NULL,
	"cc" text NOT NULL,
	"relay_node_id" uuid,
	"front_node_id" uuid,
	"exit_node_id" uuid NOT NULL,
	"exit_inbound_tag" text NOT NULL,
	"link_user_uuid" uuid NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"base_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"inbound_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"remark" text NOT NULL,
	"address" text NOT NULL,
	"port" integer NOT NULL,
	"sni" text,
	"fingerprint" text,
	"alpn" text,
	"pbk" text,
	"sid" text,
	"flow" text,
	"tag_prefix" text,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"advanced" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"config_profile_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"protocol" text DEFAULT 'vless' NOT NULL,
	"network" text DEFAULT 'tcp' NOT NULL,
	"security" text DEFAULT 'reality' NOT NULL,
	"port" integer NOT NULL,
	"flow" text DEFAULT 'xtls-rprx-vision' NOT NULL,
	"sni" text,
	"fingerprint" text DEFAULT 'firefox',
	"reality_public_key" text,
	"reality_privkey_ref" text,
	"short_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"server_id" uuid NOT NULL,
	"config_profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"consumption_multiplier" integer DEFAULT 1 NOT NULL,
	"track_traffic" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"desired_config_version" integer DEFAULT 0 NOT NULL,
	"observed_config_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_desired_state" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"config_hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"users" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_identity" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"agent_pubkey" text,
	"cert_fingerprint" text,
	"bootstrap_token_hash" text,
	"bootstrap_consumed_at" timestamp with time zone,
	"agent_epoch" integer DEFAULT 0 NOT NULL,
	"enrolled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "node_reported_state" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"agent_version" text,
	"xray_version" text,
	"applied_config_hash" text,
	"sys_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"egress_health" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"heartbeat_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "server" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"hostname" text NOT NULL,
	"primary_ip" text NOT NULL,
	"extra_ips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"country" text,
	"provider_id" uuid,
	"ssh_ref" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_status" text DEFAULT 'unknown' NOT NULL,
	"agent_version" text,
	"xray_version" text,
	"egress_health" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "squad" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "squad_inbound" (
	"squad_id" uuid NOT NULL,
	"inbound_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_squad" (
	"subscription_id" uuid NOT NULL,
	"squad_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"kind" text NOT NULL,
	"tag" text NOT NULL,
	"src_tag" text,
	"new_tag" text,
	"cc" text,
	"host_id" uuid,
	"front_node_id" uuid
);
--> statement-breakpoint
CREATE TABLE "client_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"base_json" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"serve_json_at_base" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"remark" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_auto" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"profile_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"tier" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_domain_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_domain_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_url" text,
	"checksum" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sub_response_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"match_header" text DEFAULT 'user-agent' NOT NULL,
	"match_op" text DEFAULT 'contains' NOT NULL,
	"match_value" text NOT NULL,
	"preset_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_config_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"subscription_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"list_version" integer NOT NULL,
	"base_json" jsonb NOT NULL,
	"hash" text NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_preset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"format" text DEFAULT 'happ_json' NOT NULL,
	"profile_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "online_state" (
	"subscription_id" uuid PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_ip" text,
	"ip_count" integer DEFAULT 0 NOT NULL,
	"node_id" uuid
);
--> statement-breakpoint
CREATE TABLE "traffic_daily" (
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"day" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_key" text NOT NULL,
	"node_id" uuid NOT NULL,
	"up" bigint DEFAULT 0 NOT NULL,
	"down" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "traffic_daily_org_id_day_subject_type_subject_key_node_id_pk" PRIMARY KEY("org_id","day","subject_type","subject_key","node_id")
);
--> statement-breakpoint
CREATE TABLE "traffic_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"node_id" uuid NOT NULL,
	"report_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traffic_sample" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"node_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_key" text NOT NULL,
	"up_delta" bigint DEFAULT 0 NOT NULL,
	"down_delta" bigint DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"resource_id" uuid NOT NULL,
	"amount_kopeks" bigint NOT NULL,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "infra_provider" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"kind" text,
	"account_ref" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "infra_resource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"provider_id" uuid,
	"server_id" uuid,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"monthly_cost_kopeks" bigint,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"billing_period" text DEFAULT 'month' NOT NULL,
	"next_renewal_at" timestamp with time zone,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"amount_kopeks" bigint NOT NULL,
	"entry_type" text NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"amount_kopeks" bigint NOT NULL,
	"currency" text DEFAULT 'XTR' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"period_days" integer NOT NULL,
	"price_kopeks" bigint NOT NULL,
	"traffic_gb" integer,
	"device_limit" integer,
	"is_trial" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"code" text NOT NULL,
	"kind" text DEFAULT 'percent' NOT NULL,
	"value" integer NOT NULL,
	"max_redemptions" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"referrer_subscriber_id" uuid NOT NULL,
	"referred_subscriber_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_activation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"subscription_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"plan_id" uuid,
	"added_days" integer NOT NULL,
	"new_expire_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abuse_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"subscription_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "abuse_signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"subscription_id" uuid,
	"node_id" uuid,
	"kind" text NOT NULL,
	"severity" integer DEFAULT 1 NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torrent_ban" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"node_id" uuid NOT NULL,
	"ip" text NOT NULL,
	"banned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "subscriber_device" ADD CONSTRAINT "subscriber_device_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_subscriber_id_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cascade_link" ADD CONSTRAINT "cascade_link_relay_node_id_node_id_fk" FOREIGN KEY ("relay_node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cascade_link" ADD CONSTRAINT "cascade_link_front_node_id_node_id_fk" FOREIGN KEY ("front_node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cascade_link" ADD CONSTRAINT "cascade_link_exit_node_id_node_id_fk" FOREIGN KEY ("exit_node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_inbound_id_inbound_id_fk" FOREIGN KEY ("inbound_id") REFERENCES "public"."inbound"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound" ADD CONSTRAINT "inbound_config_profile_id_config_profile_id_fk" FOREIGN KEY ("config_profile_id") REFERENCES "public"."config_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_config_profile_id_config_profile_id_fk" FOREIGN KEY ("config_profile_id") REFERENCES "public"."config_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_desired_state" ADD CONSTRAINT "node_desired_state_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_identity" ADD CONSTRAINT "node_identity_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_reported_state" ADD CONSTRAINT "node_reported_state_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squad_inbound" ADD CONSTRAINT "squad_inbound_squad_id_squad_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squad"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "squad_inbound" ADD CONSTRAINT "squad_inbound_inbound_id_inbound_id_fk" FOREIGN KEY ("inbound_id") REFERENCES "public"."inbound"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_squad" ADD CONSTRAINT "subscription_squad_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_squad" ADD CONSTRAINT "subscription_squad_squad_id_squad_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squad"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_host_id_host_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."host"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_channel" ADD CONSTRAINT "profile_channel_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_channel" ADD CONSTRAINT "profile_channel_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_domain_entry" ADD CONSTRAINT "routing_domain_entry_list_id_routing_domain_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."routing_domain_list"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_response_rule" ADD CONSTRAINT "sub_response_rule_preset_id_subscription_preset_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."subscription_preset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_config_snapshot" ADD CONSTRAINT "subscription_config_snapshot_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_state" ADD CONSTRAINT "online_state_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_state" ADD CONSTRAINT "online_state_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_daily" ADD CONSTRAINT "traffic_daily_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_report" ADD CONSTRAINT "traffic_report_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_sample" ADD CONSTRAINT "traffic_sample_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_payment" ADD CONSTRAINT "infra_payment_resource_id_infra_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."infra_resource"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_resource" ADD CONSTRAINT "infra_resource_provider_id_infra_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."infra_provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_resource" ADD CONSTRAINT "infra_resource_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_subscriber_id_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_subscriber_id_subscriber_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_referrer_subscriber_id_subscriber_id_fk" FOREIGN KEY ("referrer_subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_referred_subscriber_id_subscriber_id_fk" FOREIGN KEY ("referred_subscriber_id") REFERENCES "public"."subscriber"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_activation" ADD CONSTRAINT "subscription_activation_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_activation" ADD CONSTRAINT "subscription_activation_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_activation" ADD CONSTRAINT "subscription_activation_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_action" ADD CONSTRAINT "abuse_action_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_signal" ADD CONSTRAINT "abuse_signal_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_signal" ADD CONSTRAINT "abuse_signal_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "torrent_ban" ADD CONSTRAINT "torrent_ban_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_token_hash_uq" ON "api_token" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uq" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "user_org_email_uq" ON "user" USING btree ("org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriber_org_tg_uq" ON "subscriber" USING btree ("org_id","telegram_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriber_device_sub_hwid_uq" ON "subscriber_device" USING btree ("subscription_id","hwid");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_org_short_uuid_uq" ON "subscription" USING btree ("org_id","short_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "cascade_link_uq" ON "cascade_link" USING btree ("relay_node_id","exit_node_id","cc");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_profile_tag_uq" ON "inbound" USING btree ("config_profile_id","tag");--> statement-breakpoint
CREATE UNIQUE INDEX "node_identity_bootstrap_uq" ON "node_identity" USING btree ("bootstrap_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "server_org_hostname_uq" ON "server" USING btree ("org_id","hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "squad_inbound_uq" ON "squad_inbound" USING btree ("squad_id","inbound_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_squad_uq" ON "subscription_squad" USING btree ("subscription_id","squad_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_channel_uq" ON "profile_channel" USING btree ("profile_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_domain_list_uq" ON "routing_domain_list" USING btree ("org_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sub_snapshot_uq" ON "subscription_config_snapshot" USING btree ("subscription_id","config_version","list_version");--> statement-breakpoint
CREATE UNIQUE INDEX "traffic_report_uq" ON "traffic_report" USING btree ("node_id","report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "traffic_sample_uq" ON "traffic_sample" USING btree ("node_id","subject_type","subject_key","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "infra_payment_uq" ON "infra_payment" USING btree ("resource_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_idempotency_uq" ON "ledger_entry" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_uq" ON "payment" USING btree ("org_id","provider","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_org_code_uq" ON "plan" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_code_uq" ON "promo_code" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_uq" ON "referral" USING btree ("referred_subscriber_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sub_activation_payment_uq" ON "subscription_activation" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abuse_action_idempotency_uq" ON "abuse_action" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "torrent_ban_uq" ON "torrent_ban" USING btree ("node_id","ip","banned_at");