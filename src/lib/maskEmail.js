function maskEmail(email = '') {
  const [local = '', domain = ''] = String(email).split('@');
  if (!local || !domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

module.exports = {
  maskEmail,
};
