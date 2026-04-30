const { z } = require('zod');

const finiteNumber = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return value;
}, z.number().finite());

const positiveAmount = finiteNumber.refine((value) => value > 0, {
  message: 'Amount must be greater than 0',
});

const optionalText = z.preprocess((value) => value ?? '', z.string()).optional();
const booleanish = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}, z.boolean());

const addressSchema = z.object({
  address: z.string().trim().min(1, 'Address is required'),
  latitude: finiteNumber,
  longitude: finiteNumber,
  contactName: optionalText,
  contactPhone: optionalText,
  contactEmail: optionalText,
  landmark: optionalText,
}).strip();

const quoteAddressSchema = addressSchema.extend({
  address: optionalText,
}).strip();

const bookingQuoteSchema = z.object({
  pickupAddress: quoteAddressSchema,
  deliveryAddress: quoteAddressSchema,
  vehicleType: z.string().trim().optional(),
  deliveryMode: z.string().trim().optional(),
  offloading: booleanish.optional(),
}).strip();

const bookingCreateSchema = bookingQuoteSchema.extend({
  scheduledTime: z.string().trim().optional(),
  paymentMethod: z.string().trim().optional(),
  senderName: optionalText,
  senderPhone: optionalText,
  receiverName: optionalText,
  receiverPhone: optionalText,
  receiverEmail: optionalText,
  notes: optionalText,
}).strip();

const bookingStatusSchema = z.object({
  status: z.string().trim().min(1, 'Status is required'),
  eta: z.coerce.number().int().nonnegative().optional(),
}).strip();

const bookingVerifyDeliverySchema = z.object({
  otp: z.string().trim().min(1, 'OTP is required'),
  deliveryProofUrl: optionalText,
}).strip();

const bookingCancelSchema = z.object({
  reason: optionalText,
}).strip();

const walletTopupIntentSchema = z.object({
  amount: positiveAmount,
}).strip();

const walletPaySchema = z.object({
  bookingId: z.string().trim().min(1, 'Booking ID is required'),
}).strip();

const driverWithdrawSchema = z.object({
  amount: positiveAmount,
}).strip();

module.exports = {
  bookingCancelSchema,
  bookingCreateSchema,
  bookingQuoteSchema,
  bookingStatusSchema,
  bookingVerifyDeliverySchema,
  driverWithdrawSchema,
  walletPaySchema,
  walletTopupIntentSchema,
};
