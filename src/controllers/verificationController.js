// Verification (KYC) — submit ID + selfie + face-match for driver/vendor/provider.
const prisma = require('../config/database');
const { asyncHandler, fail, ok } = require('../utils/http');

const TYPES = ['DRIVER', 'VENDOR', 'SERVICE_PROVIDER'];
const DOC_TYPES = ['GHANA_CARD', 'PASSPORT', 'DRIVERS_LICENSE', 'STUDENT_ID', 'VOTER_ID'];

// POST /verification  { type, idDocType, idNumber?, idFrontUrl, idBackUrl?, selfieUrl, faceMatchScore? }
exports.submit = asyncHandler(async (req, res) => {
  const { type, idDocType, idNumber, idFrontUrl, idBackUrl, selfieUrl, faceMatchScore } = req.body;
  if (!TYPES.includes(type)) fail(400, 'Invalid verification type');
  if (!DOC_TYPES.includes(idDocType)) fail(400, 'Invalid ID document type');
  if (!idFrontUrl || !selfieUrl) fail(400, 'idFrontUrl and selfieUrl are required');

  // Documents must be real uploaded URLs — reject the legacy `local://` stubs and
  // any non-http reference so an admin can actually inspect them.
  const isUrl = (u) => /^https?:\/\/\S+$/.test(String(u));
  if (!isUrl(idFrontUrl) || !isUrl(selfieUrl)) fail(400, 'Upload your ID and selfie images before submitting');
  if (idBackUrl && !isUrl(idBackUrl)) fail(400, 'Invalid ID back image');

  // Re-submission overwrites any prior pending/rejected request of the same type.
  await prisma.verificationRequest.deleteMany({
    where: { userId: req.user.id, type, status: { in: ['PENDING', 'REJECTED'] } },
  });

  const score = faceMatchScore != null ? parseFloat(faceMatchScore) : null;
  const request = await prisma.verificationRequest.create({
    data: {
      userId: req.user.id, type, idDocType, idNumber, idFrontUrl, idBackUrl, selfieUrl,
      faceMatchScore: score,
      faceMatchPassed: score != null ? score >= 0.8 : null,
      status: 'PENDING',
    },
  });
  return ok(res, { verification: request, message: 'Submitted for review' }, 201);
});

// GET /verification  — latest request per type for this user
exports.status = asyncHandler(async (req, res) => {
  const requests = await prisma.verificationRequest.findMany({
    where: { userId: req.user.id }, orderBy: { submittedAt: 'desc' },
  });
  return ok(res, { verifications: requests });
});

module.exports.TYPES = TYPES;
