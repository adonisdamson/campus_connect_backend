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

// Demo vendors with menus at the pilot campus (UMaT, Tarkwa), so the food flow
// is browsable out of the box.
const VENDORS = [
  {
    email: 'jollof.hub@campusconnect.demo', name: 'Campus Jollof Hub', category: 'RESTAURANT',
    address: 'UMaT Campus Food Court', lat: 5.302, lng: -1.995, prep: 18,
    products: [
      ['Jollof + Chicken', 'Smoky party jollof with grilled chicken', 25],
      ['Fried Rice + Beef', 'Veg fried rice with tender beef', 28],
      ['Waakye Special', 'Waakye with egg, gari & shito', 20],
      ['Kelewele', 'Spiced fried plantain cup', 8],
    ],
  },
  {
    email: 'bites.corner@campusconnect.demo', name: 'Bites Corner', category: 'FAST_FOOD',
    address: 'Tarkwa Town Junction', lat: 5.310, lng: -1.998, prep: 12,
    products: [
      ['Chicken Burger', 'Crispy fillet, lettuce, house sauce', 22],
      ['Shawarma', 'Chicken shawarma with fries', 18],
      ['Meat Pie', 'Flaky pastry, seasoned mince', 6],
      ['Bottled Water', '500ml', 3],
    ],
  },
];

async function seedVendors(pilot) {
  for (const v of VENDORS) {
    const owner = await prisma.user.upsert({
      where: { email: v.email },
      update: { isVendor: true, universityId: pilot?.id },
      create: { email: v.email, fullName: v.name, isVendor: true, campusRole: 'NON_STUDENT', universityId: pilot?.id },
    });
    const existing = await prisma.vendor.findUnique({ where: { ownerId: owner.id } });
    const vendor = existing
      ? await prisma.vendor.update({ where: { id: existing.id }, data: { status: 'APPROVED', isOpen: true } })
      : await prisma.vendor.create({
          data: {
            ownerId: owner.id, name: v.name, category: v.category, address: v.address,
            lat: v.lat, lng: v.lng, prepTimeMinutes: v.prep, status: 'APPROVED', isOpen: true, ratingAvg: 4.6, ratingCount: 24,
          },
        });
    const have = await prisma.product.count({ where: { vendorId: vendor.id } });
    if (have === 0) {
      await prisma.product.createMany({
        data: v.products.map(([name, description, price]) => ({ vendorId: vendor.id, name, description, price })),
      });
    }
  }
}

const SERVICES = [
  { title: 'Braids & Cornrows', cat: 'hair', price: 60, priceType: 'STARTING_AT', desc: 'Knotless braids, cornrows & twists. Hostel visits available.' },
  { title: 'Gel & Acrylic Nails', cat: 'nails', price: 45, priceType: 'STARTING_AT', desc: 'Manicure, gel polish and acrylic sets.' },
  { title: 'Maths & Stats Tutoring', cat: 'tutoring', price: 30, priceType: 'HOURLY', desc: 'First-year calculus, stats and engineering maths.' },
  { title: 'Express Printing & Binding', cat: 'printing', price: 5, priceType: 'STARTING_AT', desc: 'Project printing, binding and lamination near campus.' },
];

async function seedServices(pilot) {
  const owner = await prisma.user.upsert({
    where: { email: 'provider.demo@campusconnect.demo' },
    update: { isServiceProvider: true, universityId: pilot?.id },
    create: { email: 'provider.demo@campusconnect.demo', fullName: 'Akua Studio', isServiceProvider: true, campusRole: 'STUDENT', universityId: pilot?.id },
  });
  const provider = await prisma.serviceProviderProfile.upsert({
    where: { userId: owner.id },
    update: { status: 'APPROVED' },
    create: { userId: owner.id, bio: 'Campus beauty & study services', status: 'APPROVED', ratingAvg: 4.7, ratingCount: 31 },
  });
  for (const s of SERVICES) {
    const category = await prisma.category.findUnique({ where: { slug: s.cat } });
    if (!category) continue;
    const exists = await prisma.serviceListing.findFirst({ where: { providerId: provider.id, title: s.title } });
    if (exists) continue;
    await prisma.serviceListing.create({
      data: {
        providerId: provider.id, categoryId: category.id, title: s.title, description: s.desc,
        basePrice: s.price, priceType: s.priceType, ratingAvg: 4.7, ratingCount: 12,
        lat: 5.302, lng: -1.995,
      },
    });
  }
}

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

async function main() {
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
  const pilot = await seedUniversities();
  await seedVendors(pilot);
  await seedServices(pilot);
  const cats = await prisma.category.count();
  const coupons = await prisma.coupon.count();
  const unis = await prisma.university.count();
  const vendors = await prisma.vendor.count();
  const products = await prisma.product.count();
  const services = await prisma.serviceListing.count();
  console.log(`Seeded: ${unis} universities, ${cats} categories, ${coupons} coupons, ${vendors} vendors, ${products} products, ${services} services`);
}

// Run standalone via `npm run seed`; also importable so the server can ensure
// reference data on boot (see services/bootstrap.js).
if (require.main === module) {
  main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}

module.exports = { main };
