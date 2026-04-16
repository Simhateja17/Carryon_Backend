const prisma = require('../src/lib/prisma');

async function main() {
  const existing = await prisma.helpArticle.count();
  if (existing > 0) {
    console.log(`[seed-help-articles] skipped: ${existing} articles already exist`);
    return;
  }

  const defaults = [
    { title: 'Getting Started as a Driver', content: 'Welcome to CarryOn! Complete your profile, upload documents, and add vehicle details to start receiving delivery requests.', category: 'Getting Started' },
    { title: 'How Earnings Work', content: 'You earn per delivery based on distance and package type. Bonuses and tips are added to your wallet instantly.', category: 'Earnings' },
    { title: 'Managing Your Account', content: 'Update your profile, vehicle details, and documents from the Profile section. Keep your information up to date.', category: 'Account' },
    { title: 'Delivery Best Practices', content: 'Always verify the package at pickup, handle with care, and confirm delivery with proof of delivery photo.', category: 'Delivery' },
    { title: 'Payment & Withdrawals', content: 'Earnings are added to your wallet after each delivery. You can withdraw to your linked bank account anytime.', category: 'Payments' },
    { title: 'Safety Guidelines', content: 'Your safety is our priority. Use the SOS button in emergencies. Always follow traffic rules and wear safety gear.', category: 'Safety' },
    { title: 'Document Requirements', content: 'Upload your driver\'s license, vehicle registration, insurance, and ID proof. All documents must be valid and clearly readable.', category: 'Account' },
    { title: 'Contact Support', content: 'Create a support ticket for any issues. Our team typically responds within 24 hours.', category: 'Support' },
  ];

  await prisma.helpArticle.createMany({ data: defaults });
  console.log(`[seed-help-articles] inserted ${defaults.length} default help articles`);
}

main()
  .catch((err) => {
    console.error('[seed-help-articles] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
