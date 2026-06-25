// Campus Connect — seed reference data (categories + demo coupons)
// Idempotent: safe to re-run. Local dev only.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const MARKETPLACE = [
  ['Electronics', 'cpu'], ['Phones', 'device-mobile'], ['Laptops', 'laptop'],
  ['Fashion', 'tshirt'], ['Shoes', 'sneaker'], ['Books', 'book-open'],
  ['Furniture', 'armchair'], ['Accessories', 'watch'], ['Gaming', 'game-controller'],
  ['Sports', 'basketball'], ['Vehicles', 'car'],
];

const SERVICE = [
  ['Hair', 'scissors'], ['Nails', 'hand'], ['Barbering', 'scissors'],
  ['Makeup', 'sparkle'], ['Laundry', 'washing-machine'], ['Printing', 'printer'],
  ['Photography', 'camera'], ['Tutoring', 'graduation-cap'], ['Repairs', 'wrench'],
  ['Graphic Design', 'palette'],
];

const VENDOR = [
  ['Restaurants', 'fork-knife'], ['Fast Food', 'hamburger'], ['Groceries', 'basket'],
  ['Pharmacy', 'first-aid-kit'], ['Convenience', 'storefront'], ['Bakery', 'bread'],
  ['Gas', 'flame'],
];

const COUPONS = [
  { code: 'WELCOME10', type: 'PERCENT', value: 10, perUserLimit: 1, appliesTo: 'ALL', minSpend: 0 },
  { code: 'RIDE5', type: 'FIXED', value: 5, perUserLimit: 3, appliesTo: 'RIDE', minSpend: 10 },
  { code: 'FREEDEL', type: 'FIXED', value: 8, perUserLimit: 2, appliesTo: 'ORDER', minSpend: 20 },
  { code: 'CAMPUS20', type: 'PERCENT', value: 20, maxRedemptions: 500, perUserLimit: 1, appliesTo: 'SERVICE', minSpend: 0 },
];

// NOTE (V5): all demo vendors / products / services / providers were removed.
// The app shows ONLY real data created by real users; screens render proper
// empty states until then. Seed now provisions reference data exclusively.

// Ghanaian universities. Campus Connect serves them all; UMaT is the live pilot
// (isActive: true), the rest are "coming soon".
const UNIVERSITIES = [
  { shortName: 'UMaT', name: 'University of Mines and Technology', city: 'Tarkwa', region: 'Western', lat: 5.301, lng: -1.996, isActive: true },
  { shortName: 'UG', name: 'University of Ghana', city: 'Accra', region: 'Greater Accra', lat: 5.6510, lng: -0.1870 },
  { shortName: 'KNUST', name: 'Kwame Nkrumah University of Science and Technology', city: 'Kumasi', region: 'Ashanti', lat: 6.6745, lng: -1.5716 },
  { shortName: 'UCC', name: 'University of Cape Coast', city: 'Cape Coast', region: 'Central', lat: 5.1153, lng: -1.2900 },
  { shortName: 'UEW', name: 'University of Education, Winneba', city: 'Winneba', region: 'Central', lat: 5.3500, lng: -0.6300 },
  { shortName: 'UDS', name: 'University for Development Studies', city: 'Tamale', region: 'Northern', lat: 9.4000, lng: -0.8500 },
  { shortName: 'UPSA', name: 'University of Professional Studies, Accra', city: 'Accra', region: 'Greater Accra', lat: 5.6300, lng: -0.1700 },
  { shortName: 'GIMPA', name: 'Ghana Institute of Management and Public Administration', city: 'Accra', region: 'Greater Accra', lat: 5.6300, lng: -0.2200 },
  { shortName: 'UHAS', name: 'University of Health and Allied Sciences', city: 'Ho', region: 'Volta', lat: 6.6000, lng: 0.4700 },
  { shortName: 'Ashesi', name: 'Ashesi University', city: 'Berekuso', region: 'Eastern', lat: 5.7600, lng: -0.2200 },
  { shortName: 'Central', name: 'Central University', city: 'Accra', region: 'Greater Accra', lat: 5.7100, lng: -0.0700 },
  { shortName: 'GCTU', name: 'Ghana Communication Technology University', city: 'Accra', region: 'Greater Accra', lat: 5.6300, lng: -0.1700 },
];

async function seedUniversities() {
  for (const u of UNIVERSITIES) {
    await prisma.university.upsert({ where: { shortName: u.shortName }, update: u, create: u });
  }
  return prisma.university.findUnique({ where: { shortName: 'UMaT' } });
}

// Remove any previously-seeded demo content (identified by the @campusconnect.demo
// owner emails) so production shows real data only. Idempotent + defensive: a
// failure on any step is logged and skipped, never crashing the deploy.
async function purgeDemo() {
  try {
    const demo = await prisma.user.findMany({
      where: { email: { endsWith: '@campusconnect.demo' } }, select: { id: true },
    });
    if (demo.length === 0) return;
    const ids = demo.map((u) => u.id);
    const vendors = await prisma.vendor.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
    const vIds = vendors.map((v) => v.id);
    if (vIds.length) {
      await prisma.product.deleteMany({ where: { vendorId: { in: vIds } } }).catch(() => {});
      await prisma.vendor.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    }
    const profs = await prisma.serviceProviderProfile.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const pIds = profs.map((p) => p.id);
    if (pIds.length) {
      await prisma.serviceListing.deleteMany({ where: { providerId: { in: pIds } } }).catch(() => {});
      await prisma.serviceProviderProfile.deleteMany({ where: { id: { in: pIds } } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    console.log(`Purged ${ids.length} demo account(s) and their content`);
  } catch (e) {
    console.error('[seed] purgeDemo skipped:', e.message);
  }
}

async function main() {
  await purgeDemo();
  const groups = [['MARKETPLACE', MARKETPLACE], ['SERVICE', SERVICE], ['VENDOR', VENDOR]];
  for (const [type, items] of groups) {
    for (const [name, icon] of items) {
      const s = slug(name);
      await prisma.category.upsert({
        where: { slug: s },
        update: { name, type, icon },
        create: { name, slug: s, type, icon },
      });
    }
  }
  for (const c of COUPONS) {
    await prisma.coupon.upsert({ where: { code: c.code }, update: c, create: c });
  }
  await seedUniversities();
  const cats = await prisma.category.count();
  const coupons = await prisma.coupon.count();
  const unis = await prisma.university.count();
  console.log(`Seeded reference data only: ${unis} universities, ${cats} categories, ${coupons} coupons (no demo content — real data only)`);
}

// Run standalone via `npm run seed`; also importable so the server can ensure
// reference data on boot (see services/bootstrap.js).
if (require.main === module) {
  main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}

module.exports = { main, purgeDemo };
