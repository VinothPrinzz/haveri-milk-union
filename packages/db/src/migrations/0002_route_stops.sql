-- Migration 0002: Route stops + minor schema additions
-- Run this after 0001_initial_schema.sql

-- Add JSONB column for detailed stop information
ALTER TABLE routes ADD COLUMN IF NOT EXISTS stop_details jsonb DEFAULT '[]'::jsonb;
-- stop_details format: [{"name": "Stop 1", "distanceFromPrev": 5.2}, {"name": "Stop 2", "distanceFromPrev": 3.8}]

-- Add vehicle_number directly on route_assignments for convenience
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS vehicle_number text;

-- Ensure notification_config has the right columns
ALTER TABLE notification_config ALTER COLUMN push_enabled SET DEFAULT true;
