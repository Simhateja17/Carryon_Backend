const ACTORS = {
  CUSTOMER: 'CUSTOMER',
  DRIVER: 'DRIVER',
};

const customerTree = [
  {
    id: 'customer.order',
    label: 'Order or delivery issue',
    children: [
      issue('customer.order.delay', 'Delivery is delayed', 'DELIVERY_ISSUE', 'MEDIUM', { requiresBooking: true }),
      issue('customer.order.address', 'Pickup or drop-off address problem', 'DELIVERY_ISSUE', 'MEDIUM', { requiresBooking: true }),
      issue('customer.order.driver_complaint', 'Driver or service complaint', 'DRIVER_COMPLAINT', 'HIGH', { requiresBooking: true }),
    ],
  },
  {
    id: 'customer.package',
    label: 'Package damaged or missing',
    children: [
      issue('customer.package.damaged', 'Package arrived damaged', 'DELIVERY_ISSUE', 'HIGH', { requiresBooking: true, requiresDetails: true, allowsAttachments: true }),
      issue('customer.package.missing', 'Package is missing', 'DELIVERY_ISSUE', 'HIGH', { requiresBooking: true, requiresDetails: true }),
    ],
  },
  {
    id: 'customer.payment',
    label: 'Payment, wallet, or refund',
    children: [
      issue('customer.payment.refund', 'Refund request', 'REFUND_REQUEST', 'HIGH', { requiresBooking: true, requiresDetails: true }),
      issue('customer.payment.charge', 'Delivery charge dispute', 'PAYMENT_ISSUE', 'HIGH', { requiresBooking: true, requiresDetails: true }),
      issue('customer.payment.wallet', 'Wallet or top-up issue', 'PAYMENT_ISSUE', 'HIGH', { requiresDetails: true }),
    ],
  },
  {
    id: 'customer.app',
    label: 'App problem',
    children: [
      issue('customer.app.booking', 'Cannot book or manage delivery', 'APP_BUG', 'MEDIUM', { requiresDetails: true, allowsAttachments: true }),
      issue('customer.app.crash', 'App crashes or freezes', 'APP_BUG', 'MEDIUM', { requiresDetails: true, allowsAttachments: true }),
    ],
  },
  {
    id: 'customer.account',
    label: 'Account or profile',
    children: [
      issue('customer.account.profile', 'Profile or phone number issue', 'OTHER', 'LOW', { requiresDetails: true }),
      issue('customer.account.security', 'Account security concern', 'OTHER', 'URGENT', { requiresDetails: true }),
    ],
  },
  {
    id: 'customer.other',
    label: 'Something else',
    children: [
      issue('customer.other.general', 'General support request', 'OTHER', 'LOW', { requiresDetails: true }),
    ],
  },
];

const driverTree = [
  {
    id: 'driver.job',
    label: 'Job, pickup, or drop-off problem',
    children: [
      issue('driver.job.pickup', 'Pickup problem', 'DELIVERY', 'HIGH', { requiresBooking: true, requiresDetails: true }),
      issue('driver.job.dropoff', 'Drop-off problem', 'DELIVERY', 'HIGH', { requiresBooking: true, requiresDetails: true }),
      issue('driver.job.customer_unreachable', 'Customer unreachable', 'DELIVERY', 'HIGH', { requiresBooking: true }),
      issue('driver.job.otp', 'OTP or proof issue', 'DELIVERY', 'HIGH', { requiresBooking: true, requiresDetails: true }),
    ],
  },
  {
    id: 'driver.earnings',
    label: 'Earnings or payout issue',
    children: [
      issue('driver.earnings.payout', 'Payout issue', 'PAYMENT', 'HIGH', { requiresDetails: true }),
      issue('driver.earnings.job_payment', 'Job payment dispute', 'PAYMENT', 'HIGH', { requiresBooking: true, requiresDetails: true }),
    ],
  },
  {
    id: 'driver.vehicle',
    label: 'Vehicle or document verification',
    children: [
      issue('driver.vehicle.documents', 'Document verification issue', 'VEHICLE', 'MEDIUM', { requiresDetails: true, allowsAttachments: true }),
      issue('driver.vehicle.profile', 'Vehicle profile issue', 'VEHICLE', 'MEDIUM', { requiresDetails: true }),
    ],
  },
  {
    id: 'driver.app',
    label: 'App or navigation problem',
    children: [
      issue('driver.app.location', 'Location or navigation issue', 'APP_BUG', 'MEDIUM', { requiresBooking: true, requiresDetails: true, allowsAttachments: true }),
      issue('driver.app.crash', 'App crashes or freezes', 'APP_BUG', 'MEDIUM', { requiresDetails: true, allowsAttachments: true }),
    ],
  },
  {
    id: 'driver.safety',
    label: 'Emergency or safety issue',
    children: [
      issue('driver.safety.sos', 'Emergency or safety concern', 'GENERAL', 'URGENT', { requiresDetails: false, emergency: true }),
      issue('driver.safety.complaint', 'Customer safety complaint', 'GENERAL', 'URGENT', { requiresBooking: true, requiresDetails: true }),
    ],
  },
  {
    id: 'driver.other',
    label: 'Something else',
    children: [
      issue('driver.other.general', 'General support request', 'GENERAL', 'LOW', { requiresDetails: true }),
    ],
  },
];

function issue(id, label, category, priority, flags = {}) {
  return {
    id,
    label,
    category,
    priority,
    requiresBooking: false,
    requiresDetails: false,
    allowsAttachments: false,
    emergency: false,
    ...flags,
  };
}

function optionsForActor(actor) {
  if (actor === ACTORS.DRIVER) return driverTree;
  return customerTree;
}

function flattenIssues(tree) {
  return tree.flatMap((group) => group.children || []);
}

function findIssue(actor, issueId) {
  return flattenIssues(optionsForActor(actor)).find((item) => item.id === issueId) || null;
}

function findPath(actor, issueId) {
  for (const group of optionsForActor(actor)) {
    const child = (group.children || []).find((item) => item.id === issueId);
    if (child) return [{ id: group.id, label: group.label }, { id: child.id, label: child.label }];
  }
  return [];
}

function makeSubject({ actor, issue, booking }) {
  const prefix = actor === ACTORS.DRIVER ? 'Driver support' : 'Customer support';
  const order = booking?.orderCode ? ` for order ${booking.orderCode}` : '';
  return `${prefix}: ${issue.label}${order}`;
}

function summarizeIntake({ actor, issue, path, booking, details, answers = {} }) {
  const requester = actor === ACTORS.DRIVER ? 'Driver' : 'Customer';
  const lines = [
    `Issue: ${issue.label}`,
    booking?.orderCode ? `Order: ${booking.orderCode}` : null,
    `Requester: ${requester}`,
    `Selected path: ${path.map((item) => item.label).join(' > ')}`,
    details ? `Details: ${details}` : null,
  ].filter(Boolean);

  const answerEntries = Object.entries(answers || {})
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (answerEntries.length > 0) {
    lines.push('Answers:');
    for (const [key, value] of answerEntries) {
      lines.push(`- ${key}: ${String(value)}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  ACTORS,
  findIssue,
  findPath,
  makeSubject,
  optionsForActor,
  summarizeIntake,
};
