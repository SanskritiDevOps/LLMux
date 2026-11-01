/*
  Warnings:

  - You are about to drop the column `monthly_budget_micro_usd` on the `api_keys` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "api_keys" DROP COLUMN "monthly_budget_micro_usd";
