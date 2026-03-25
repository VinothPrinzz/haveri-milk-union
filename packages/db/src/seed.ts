/**
 * Seed script for development — run with: pnpm --filter @hmu/db seed
 *
 * Prerequisites:
 *   1. Database exists and migration 0001 has been applied
 *   2. DATABASE_URL is set in .env
 *
 * This script inserts:
 *   - A default Super Admin user (admin@haverimunion.coop / admin123)
 *   - Sample dealers with wallets
 *   - Sample routes
 *   - Sample vehicles
 */

import dotenv from "dotenv";
import path from "path";
import postgres from "postgres";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.resolve(__dirname, "../../../.env"),
});

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL in .env");
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

async function seed() {
  console.log("🌱 Seeding database...\n");

  // ── 1. Super Admin user ──
  // Password: admin123 (bcrypt hash — in production use proper hashing in the API)
  // This is a placeholder hash. The actual API auth will use bcrypt.
  const adminHash = "$2b$10$K4GXDfN8tYQWp5EFX5R8TOy8vj7aHnXEFyQ1tY2Z6yJ7dLPKK6HKG"; // placeholder
  const [admin] = await sql`
    INSERT INTO users (name, email, password_hash, role, phone)
    VALUES ('Admin', 'admin@haverimunion.coop', ${adminHash}, 'super_admin', '+918382123456')
    ON CONFLICT (email) DO NOTHING
    RETURNING id, name, email, role
  `;
  if (admin) {
    console.log(`  ✅ Super Admin: ${admin.email} (${admin.role})`);
  } else {
    console.log(`  ⏭️  Super Admin already exists`);
  }

  // ── 2. Additional admin users ──
  const adminUsers = [
    { name: "Rajesh Kumar",    email: "rajesh@haverimunion.coop",    role: "manager",          phone: "+919876543001" },
    { name: "Suresh M",        email: "suresh@haverimunion.coop",    role: "dispatch_officer",  phone: "+919876543002" },
    { name: "Priya Patil",     email: "priya@haverimunion.coop",     role: "accountant",        phone: "+919876543003" },
    { name: "Anita Desai",     email: "anita@haverimunion.coop",     role: "call_desk",         phone: "+919876543004" },
  ];
  for (const u of adminUsers) {
    await sql`
      INSERT INTO users (name, email, password_hash, role, phone)
      VALUES (${u.name}, ${u.email}, ${adminHash}, ${u.role}::user_role, ${u.phone})
      ON CONFLICT (email) DO NOTHING
    `;
  }
  console.log(`  ✅ Admin users seeded (${adminUsers.length} users)`);

  // ── 3. Sample dealers ──
  const zones = await sql`SELECT id, slug FROM zones`;
  const zoneMap = Object.fromEntries(zones.map((z) => [z.slug, z.id]));

  const dealerData = [
    { name: "Raju Agencies",        phone: "9876543210", zone: "haveri",     gst: "29ABCDE1234F1Z5", address: "Main Road, Haveri",         city: "Haveri",     pin: "581110", location: "Haveri Main Market",     balance: 12500 },
    { name: "Sri Lakshmi Traders",  phone: "9876543211", zone: "ranebennur", gst: "29FGHIJ5678K2Y4", address: "Station Road, Ranebennur",  city: "Ranebennur", pin: "581115", location: "Ranebennur Market",      balance: 8200 },
    { name: "Mahalakshmi Stores",   phone: "9876543212", zone: "savanur",    gst: null,              address: "Main Street, Savanur",      city: "Savanur",    pin: "581118", location: "Savanur Town",           balance: 0 },
    { name: "Krishna Dairy Point",  phone: "9876543213", zone: "byadgi",     gst: "29KLMNO9012P3X3", address: "Market Road, Byadgi",       city: "Byadgi",     pin: "581106", location: "Byadgi Circle",          balance: 5600 },
    { name: "Ganesh Milk Center",   phone: "9876543214", zone: "hirekerur",  gst: "29PQRST3456U4W2", address: "Temple Road, Hirekerur",    city: "Hirekerur",  pin: "581120", location: "Hirekerur Town Center",  balance: 3100 },
    { name: "Srinivas Distributors",phone: "9876543215", zone: "hangal",     gst: "29UVWXY7890Z5V1", address: "Bus Stand Road, Hangal",    city: "Hangal",     pin: "581104", location: "Hangal Bus Stand",       balance: 7500 },
  ];

  for (const d of dealerData) {
    const [dealer] = await sql`
      INSERT INTO dealers (name, phone, gst_number, zone_id, address, city, pin_code, location_label, active)
      VALUES (
        ${d.name}, ${d.phone}, ${d.gst}, ${zoneMap[d.zone]},
        ${d.address}, ${d.city}, ${d.pin}, ${d.location}, ${d.name !== "Mahalakshmi Stores"}
      )
      ON CONFLICT (phone) DO NOTHING
      RETURNING id
    `;

    if (dealer) {
      await sql`
        INSERT INTO dealer_wallets (dealer_id, balance)
        VALUES (${dealer.id}, ${d.balance})
        ON CONFLICT (dealer_id) DO NOTHING
      `;
    }
  }
  console.log(`  ✅ Dealers seeded (${dealerData.length} dealers with wallets)`);

  // ── 4. Sample routes ──
  const routeData = [
    { code: "R1", name: "Haveri Central",   zone: "haveri",     stops: 12, km: 28 },
    { code: "R2", name: "Haveri East",      zone: "haveri",     stops: 8,  km: 22 },
    { code: "R3", name: "Ranebennur Main",  zone: "ranebennur", stops: 15, km: 35 },
    { code: "R4", name: "Savanur Route A",  zone: "savanur",    stops: 10, km: 18 },
    { code: "R5", name: "Byadgi Circle",    zone: "byadgi",     stops: 6,  km: 15 },
    { code: "R6", name: "Hirekerur Town",   zone: "hirekerur",  stops: 9,  km: 20 },
  ];

  for (const r of routeData) {
    await sql`
      INSERT INTO routes (code, name, zone_id, stops, distance_km, active)
      VALUES (${r.code}, ${r.name}, ${zoneMap[r.zone]}, ${r.stops}, ${r.km}, ${r.code !== "R5"})
      ON CONFLICT (code) DO NOTHING
    `;
  }
  console.log(`  ✅ Routes seeded (${routeData.length} routes)`);

  // ── 5. Sample vehicles ──
  const vehicleData = [
    { number: "KA-25-AB-1234", type: "truck", capacity: "2 Ton", driver: "Ramesh K.",    phone: "+919876543100" },
    { number: "KA-25-XY-4321", type: "van",   capacity: "1 Ton", driver: "Kumar S.",     phone: "+919876543101" },
    { number: "KA-25-CD-5678", type: "truck", capacity: "2 Ton", driver: "Suresh M.",    phone: "+919876543102" },
    { number: "KA-25-EF-9012", type: "tempo", capacity: "1.5 Ton", driver: "Manjunath R.",phone: "+919876543103" },
    { number: "KA-25-GH-3456", type: "van",   capacity: "1 Ton", driver: "Prasad B.",    phone: "+919876543104" },
    { number: "KA-25-IJ-7890", type: "truck", capacity: "2 Ton", driver: "Mahesh H.",    phone: "+919876543105" },
  ];

  for (const v of vehicleData) {
    await sql`
      INSERT INTO vehicles (number, type, capacity, driver_name, driver_phone)
      VALUES (${v.number}, ${v.type}, ${v.capacity}, ${v.driver}, ${v.phone})
      ON CONFLICT (number) DO NOTHING
    `;
  }
  console.log(`  ✅ Vehicles seeded (${vehicleData.length} vehicles)`);

  console.log("\n🎉 Seed complete!");
  await sql.end();
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
