-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "rate_limit_per_min" INTEGER,
    "monthly_budget_micro_usd" BIGINT,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_logs" (
    "id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "api_key_id" UUID NOT NULL,
    "model_alias" TEXT NOT NULL,
    "provider" TEXT,
    "provider_model" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "usage_estimated" BOOLEAN NOT NULL DEFAULT false,
    "cost_micro_usd" BIGINT NOT NULL DEFAULT 0,
    "saved_micro_usd" BIGINT NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL,
    "time_to_first_token_ms" INTEGER,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "fallback_used" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "streamed" BOOLEAN NOT NULL DEFAULT false,
    "transport" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_logs_request_id_key" ON "usage_logs"("request_id");

-- CreateIndex
CREATE INDEX "usage_logs_api_key_id_created_at_idx" ON "usage_logs"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_logs_provider_created_at_idx" ON "usage_logs"("provider", "created_at");

-- CreateIndex
CREATE INDEX "usage_logs_model_alias_created_at_idx" ON "usage_logs"("model_alias", "created_at");

-- CreateIndex
CREATE INDEX "usage_logs_created_at_idx" ON "usage_logs"("created_at");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
