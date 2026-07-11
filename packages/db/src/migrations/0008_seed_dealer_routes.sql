-- Seed dealer route assignments based on zone
-- Each dealer in a zone gets assigned to a route in that same zone.
DO $$
DECLARE
  rec RECORD;
  v_route_id uuid;
BEGIN
  FOR rec IN
    SELECT id, zone_id, name FROM dealers
    WHERE route_id IS NULL AND deleted_at IS NULL
  LOOP
    -- Pick the first active route in the dealer's zone
    SELECT id INTO v_route_id FROM routes
    WHERE zone_id = rec.zone_id
      AND active = true
      AND deleted_at IS NULL
    ORDER BY code
    LIMIT 1;

    IF v_route_id IS NOT NULL THEN
      UPDATE dealers SET route_id = v_route_id WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;