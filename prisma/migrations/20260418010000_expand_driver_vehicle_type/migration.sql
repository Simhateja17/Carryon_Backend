-- Expand DriverVehicleType enum from {BIKE,CAR,VAN,TRUCK} to the 8-value set
-- matching what the user app already sends. Existing rows are remapped:
--   VAN   -> VAN_7FT
--   TRUCK -> LORRY_10FT
--   BIKE, CAR unchanged.

CREATE TYPE "DriverVehicleType_new" AS ENUM (
  'BIKE',
  'CAR',
  'PICKUP',
  'VAN_7FT',
  'VAN_9FT',
  'LORRY_10FT',
  'LORRY_14FT',
  'LORRY_17FT'
);

ALTER TABLE "DriverVehicle" ALTER COLUMN "type" DROP DEFAULT;

ALTER TABLE "DriverVehicle"
  ALTER COLUMN "type" TYPE "DriverVehicleType_new"
  USING (
    CASE "type"::text
      WHEN 'VAN'   THEN 'VAN_7FT'
      WHEN 'TRUCK' THEN 'LORRY_10FT'
      ELSE "type"::text
    END
  )::"DriverVehicleType_new";

ALTER TABLE "DriverVehicle" ALTER COLUMN "type" SET DEFAULT 'CAR';

DROP TYPE "DriverVehicleType";
ALTER TYPE "DriverVehicleType_new" RENAME TO "DriverVehicleType";
