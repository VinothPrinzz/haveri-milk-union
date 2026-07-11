-- Add dispatch_time column to routes table (default departure time)
ALTER TABLE routes ADD COLUMN IF NOT EXISTS dispatch_time text;

-- Seed default dispatch times for existing routes
UPDATE routes SET dispatch_time = '5:30 AM' WHERE dispatch_time IS NULL AND code IN ('R1', 'R2');
UPDATE routes SET dispatch_time = '6:00 AM' WHERE dispatch_time IS NULL AND code IN ('R3', 'R5');
UPDATE routes SET dispatch_time = '6:30 AM' WHERE dispatch_time IS NULL AND code IN ('R4');
UPDATE routes SET dispatch_time = '7:00 AM' WHERE dispatch_time IS NULL AND code IN ('R6');
-- Default for any other routes
UPDATE routes SET dispatch_time = '6:00 AM' WHERE dispatch_time IS NULL;