import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateAssistantReply, type AssistantMessage } from './ai.js';
import { currentUser, exchangeRecoveryCode, login, refresh, register, requestPasswordReset, updatePassword, requireRole, type CurrentUser } from './auth.js';
import { config } from './config.js';
import { sendChatMessageEmail, sendProposalReceivedEmail, sendRequestCreatedEmail, sendRequestRejectedEmail, sendSessionCancelledEmail, sendSessionConfirmedEmail } from './email.js';
import {
  HttpError,
  optionalString,
  readJson,
  requireNumber,
  requireString,
  sendData,
  sendError,
  setCors,
} from './http.js';
import { db, supabaseAdmin } from './supabase.js';

const urlFor = (req: IncomingMessage): URL => new URL(req.url ?? '/', 'http://localhost');
const idFrom = (value: string | undefined, field: string): string => requireString(value, field, 10, 80);
const dateValue = (value: unknown, field: string): string => {
  const date = new Date(requireString(value, field, 10, 80));
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'INVALID_DATE', `El campo ${field} debe ser una fecha válida.`);
  return date.toISOString();
};

const supabaseError = (message: string, error: { message?: string } | null | undefined, status = 500): never => {
  throw new HttpError(status, 'DATABASE_ERROR', message, error?.message);
};
const AVATAR_BUCKET = 'avatars';
const AVATAR_MAX_BYTES = 300 * 1024;
const avatarFromDataUrl = (value: unknown): { buffer: Buffer; contentType: string } | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_AVATAR', 'La imagen de perfil no es válida.');
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new HttpError(400, 'INVALID_AVATAR', 'Usa una imagen JPG, PNG o WebP válida.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > AVATAR_MAX_BYTES) throw new HttpError(413, 'AVATAR_TOO_LARGE', 'La foto debe pesar máximo 300 KB.');
  return { buffer, contentType: match[1] };
};
const updateAvatar = async (user: CurrentUser, value: unknown) => {
  const avatar = avatarFromDataUrl(value);
  const path = `${user.id}/avatar.webp`;
  if (!avatar) {
    const { error: removeError } = await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([path]);
    if (removeError && !removeError.message.toLowerCase().includes('not found')) supabaseError('No se pudo eliminar la foto anterior.', removeError);
    const { data, error } = await db.from('users').update({ avatar_url: null, updated_at: new Date().toISOString() }).eq('id', user.id).select('id, email, full_name, phone, avatar_url').single();
    if (error) supabaseError('No se pudo actualizar la foto de perfil.', error);
    return data;
  }
  const { error: uploadError } = await supabaseAdmin.storage.from(AVATAR_BUCKET).upload(path, avatar.buffer, { contentType: avatar.contentType, upsert: true, cacheControl: '3600' });
  if (uploadError) supabaseError('No se pudo guardar la foto de perfil.', uploadError);
  const { data: publicData } = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  const avatarUrl = `${publicData.publicUrl}?v=${Date.now()}`;
  const { data, error } = await db.from('users').update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() }).eq('id', user.id).select('id, email, full_name, phone, avatar_url').single();
  if (error) supabaseError('No se pudo actualizar la foto de perfil.', error);
  return data;
};

const getRequest = async (requestId: string) => {
  const { data, error } = await db.from('tutoring_requests').select('*').eq('id', requestId).maybeSingle();
  if (error) supabaseError('No se pudo consultar la solicitud.', error);
  if (!data) throw new HttpError(404, 'REQUEST_NOT_FOUND', 'La solicitud no existe.');
  const { data: student, error: studentError } = await db.from('users').select('id, full_name, email, phone').eq('id', data.student_id).maybeSingle();
  if (studentError) supabaseError('No se pudo consultar la información del estudiante.', studentError);
  return { ...(data as Record<string, any>), student: student || null } as Record<string, any>;
};

const getProposal = async (proposalId: string) => {
  const { data, error } = await db.from('tutoring_proposals').select('*').eq('id', proposalId).maybeSingle();
  if (error) supabaseError('No se pudo consultar la propuesta.', error);
  if (!data) throw new HttpError(404, 'PROPOSAL_NOT_FOUND', 'La propuesta no existe.');
  return data as Record<string, any>;
};

const getSession = async (sessionId: string) => {
  const { data, error } = await db.from('tutoring_sessions').select('*').eq('id', sessionId).maybeSingle();
  if (error) supabaseError('No se pudo consultar la tutoría.', error);
  if (!data) throw new HttpError(404, 'SESSION_NOT_FOUND', 'La tutoría no existe.');
  return data as Record<string, any>;
};

const getAccountContact = async (userId: string) => {
  const { data, error } = await db.from('users').select('email, full_name').eq('id', userId).maybeSingle();
  if (error) supabaseError('No se pudo consultar el contacto de la cuenta.', error);
  if (!data?.email) throw new HttpError(422, 'CONTACT_NOT_FOUND', 'La cuenta no tiene un correo electrónico disponible.');
  return { email: data.email as string, fullName: (data.full_name as string) || 'Usuario de ÁgoraHub' };
};

const getMeeting = async (user: CurrentUser, sessionId: string) => {
  const session = await getSession(sessionId);
  requireSessionParticipant(user, session);
  if (session.modality !== 'online') throw new HttpError(409, 'SESSION_NOT_ONLINE', 'Esta tutoría no tiene modalidad virtual.');
  let meetingUrl = typeof session.meeting_url === 'string' ? session.meeting_url : null;
  let roomName: string | null = null;
  const expectedRoom = `agorahub-${session.id.replaceAll('-', '')}`;
  if (meetingUrl) {
    try {
      const parsed = new URL(meetingUrl);
      const parsedRoom = parsed.pathname.replace(/^\/+/, '');
      if (parsed.hostname === config.jitsiDomain && parsedRoom === expectedRoom) roomName = parsedRoom;
    } catch {
      meetingUrl = null;
    }
  }
  if (!meetingUrl || !roomName) {
    roomName = expectedRoom;
    meetingUrl = `https://${config.jitsiDomain}/${roomName}`;
    const { error } = await db.from('tutoring_sessions').update({ meeting_url: meetingUrl, updated_at: new Date().toISOString() }).eq('id', session.id);
    if (error) supabaseError('No se pudo preparar el aula virtual.', error);
  }
  return { sessionId: session.id, domain: config.jitsiDomain, roomName, meetingUrl, provider: 'jitsi', openExternally: true };
};

const listTutors = async (url: URL) => {
  let query = db.from('tutor_search_view').select('*').limit(50);
  const subject = url.searchParams.get('subject');
  const modality = url.searchParams.get('modality');
  const area = url.searchParams.get('area');
  if (subject) query = query.ilike('subjects', `%${subject}%`);
  if (modality && ['online', 'in_person', 'both'].includes(modality)) query = query.in('teaching_modality', modality === 'both' ? ['both'] : [modality, 'both']);
  if (area) query = query.ilike('service_area', `%${area}%`);
  const { data, error } = await query.order('average_rating', { ascending: false });
  if (error) supabaseError('No se pudo realizar la búsqueda de tutores.', error);
  const rows = data ?? [];
  const ids = rows.map((row) => row.tutor_id || row.id).filter(Boolean);
  const { data: reviews, error: reviewsError } = ids.length ? await db.from('tutor_reviews').select('tutor_id, rating').in('tutor_id', ids).eq('is_published', true) : { data: [], error: null };
  if (reviewsError) supabaseError('No se pudieron consultar las reseñas de los tutores.', reviewsError);
  const reviewMap = new Map<string, { count: number; total: number }>();
  (reviews ?? []).forEach((review) => { const current = reviewMap.get(review.tutor_id) || { count: 0, total: 0 }; current.count += 1; current.total += Number(review.rating || 0); reviewMap.set(review.tutor_id, current); });
  return rows.map((row) => { const stats = reviewMap.get(row.tutor_id || row.id); return { ...row, review_count: stats?.count ?? Number(row.review_count || 0), average_rating: stats?.count ? Number((stats.total / stats.count).toFixed(1)) : Number(row.average_rating || 0) }; });
};

const tutorDetail = async (tutorId: string) => {
  const [{ data: tutor, error: tutorError }, { data: subjects, error: subjectsError }, { data: availability, error: availabilityError }, { data: reviews, error: reviewsError }, { data: blogs, error: blogsError }] = await Promise.all([
    db.from('tutor_profiles').select('*').eq('user_id', tutorId).maybeSingle(),
    db.from('tutor_subjects').select('subject_id, hourly_rate, is_primary, subjects(id, name)').eq('tutor_id', tutorId),
    db.from('tutor_availability_rules').select('*').eq('tutor_id', tutorId).eq('is_active', true).order('day_of_week').order('start_time'),
    db.from('tutor_reviews').select('id, session_id, rating, comment, created_at, student_id').eq('tutor_id', tutorId).eq('is_published', true).order('created_at', { ascending: false }).limit(50),
    db.from('tutor_blogs').select('id, title, content, status, created_at, updated_at').eq('tutor_id', tutorId).eq('status', 'published').order('updated_at', { ascending: false }).limit(20),
  ]);
  if (tutorError) supabaseError('No se pudo consultar el perfil del tutor.', tutorError);
  if (subjectsError) supabaseError('No se pudieron consultar las materias del tutor.', subjectsError);
  if (availabilityError) supabaseError('No se pudo consultar la disponibilidad del tutor.', availabilityError);
  if (reviewsError) supabaseError('No se pudieron consultar las reseñas del tutor.', reviewsError);
  if (blogsError) supabaseError('No se pudieron consultar los blogs del tutor.', blogsError);
  if (!tutor) throw new HttpError(404, 'TUTOR_NOT_FOUND', 'El tutor no existe.');
  const { data: user, error: userError } = await db.from('users').select('id, full_name, email, phone, avatar_url').eq('id', tutorId).maybeSingle();
  if (userError) supabaseError('No se pudo consultar la identidad del tutor.', userError);
  const reviewerIds = (reviews ?? []).map((review) => review.student_id).filter(Boolean);
  const { data: reviewerAccounts, error: reviewerError } = reviewerIds.length ? await db.from('users').select('id, full_name').in('id', reviewerIds) : { data: [], error: null };
  if (reviewerError) supabaseError('No se pudieron consultar los nombres de los estudiantes.', reviewerError);
  const reviewerNames = new Map((reviewerAccounts ?? []).map((account) => [account.id, account.full_name]));
  const publicReviews = (reviews ?? []).map((review) => ({ ...review, student_name: reviewerNames.get(review.student_id) || 'Estudiante' }));
  const reviewCount = publicReviews.length;
  const averageRating = reviewCount ? Number((publicReviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviewCount).toFixed(1)) : 0;
  return { ...tutor, review_count: reviewCount, average_rating: averageRating, user, subjects: subjects ?? [], availability: availability ?? [], reviews: publicReviews, blogs: blogs ?? [] };
};

const tutorMetrics = async (tutorId: string) => {
  const { data: sessions, error: sessionsError } = await db.from('tutoring_sessions').select('id, status, starts_at, ends_at, accepted_proposal_id').eq('tutor_id', tutorId).order('starts_at', { ascending: true });
  if (sessionsError) supabaseError('No se pudieron calcular las métricas del tutor.', sessionsError);
  const rows = sessions ?? [];
  const proposalIds = rows.map((session) => session.accepted_proposal_id).filter(Boolean);
  const { data: proposals, error: proposalsError } = proposalIds.length ? await db.from('tutoring_proposals').select('id, proposed_hourly_rate').in('id', proposalIds) : { data: [], error: null };
  if (proposalsError) supabaseError('No se pudieron calcular los ingresos del tutor.', proposalsError);
  const rateByProposal = new Map((proposals ?? []).map((proposal) => [proposal.id, Number(proposal.proposed_hourly_rate || 0)]));
  const completed = rows.filter((session) => ['completed', 'review_pending'].includes(session.status));
  const hours = completed.reduce((total, session) => total + Math.max(0, (new Date(session.ends_at).getTime() - new Date(session.starts_at).getTime()) / 3600000), 0);
  const income = completed.reduce((total, session) => total + (rateByProposal.get(session.accepted_proposal_id) || 0) * Math.max(0, (new Date(session.ends_at).getTime() - new Date(session.starts_at).getTime()) / 3600000), 0);
  const upcoming = rows.filter((session) => ['scheduled', 'in_progress'].includes(session.status));
  const responseRate = proposalIds.length ? 100 : null;
  return { upcomingCount: upcoming.length, completedCount: completed.length, cancelledCount: rows.filter((session) => session.status === 'cancelled').length, hours: Number(hours.toFixed(2)), incomeUsd: Number(income.toFixed(2)), responseRate, sessions: rows };
};

const studentMetrics = async (studentId: string) => {
  const { data: sessions, error } = await db.from('tutoring_sessions').select('id, status, starts_at, ends_at').eq('student_id', studentId).order('starts_at', { ascending: true });
  if (error) supabaseError('No se pudieron calcular tus métricas de aprendizaje.', error);
  const completed = (sessions ?? []).filter((session) => ['completed', 'review_pending'].includes(session.status));
  const durationHours = (session: Record<string, any>) => Math.max(0, (new Date(session.ends_at).getTime() - new Date(session.starts_at).getTime()) / 3600000);
  const totalHours = completed.reduce((sum, session) => sum + durationHours(session), 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dateKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const completedDays = new Set(completed.map((session) => { const date = new Date(session.starts_at); date.setHours(0, 0, 0, 0); return dateKey(date); }));
  let streakDays = 0;
  const latestCompleted = completed.length ? [...completed].sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime())[0] : null;
  const cursor = latestCompleted ? new Date(latestCompleted.starts_at) : new Date(today);
  cursor.setHours(0, 0, 0, 0);
  while (latestCompleted && completedDays.has(dateKey(cursor))) {
    streakDays += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  const weekStart = new Date(today);
  const mondayOffset = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - mondayOffset);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weeklyHours = completed.filter((session) => { const date = new Date(session.starts_at); return date >= weekStart && date < weekEnd; }).reduce((sum, session) => sum + durationHours(session), 0);
  const weeklyProgress = Math.min(100, Math.round((weeklyHours / 5) * 100));
  return { totalHours: Number(totalHours.toFixed(2)), completedCount: completed.length, streakDays, weeklyHours: Number(weeklyHours.toFixed(2)), weeklyProgress };
};

const requireStudentOwner = (user: CurrentUser, row: Record<string, any>) => {
  requireRole(user, ['student']);
  if (row.student_id !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Solo puedes consultar tus propias solicitudes.');
};

const requireSessionParticipant = (user: CurrentUser, session: Record<string, any>) => {
  if (session.student_id !== user.id && session.tutor_id !== user.id) throw new HttpError(403, 'FORBIDDEN', 'No participas en esta tutoría.');
};

const acceptProposalAndCreateSession = async (request: Record<string, any>, proposal: Record<string, any>) => {
  const { data: existingSession, error: existingSessionError } = await db.from('tutoring_sessions').select('*').eq('request_id', request.id).maybeSingle();
  if (existingSessionError) supabaseError('No se pudo comprobar si la solicitud ya tiene una tutoría.', existingSessionError);
  if (existingSession) return existingSession;

  const start = proposal.proposed_starts_at ?? request.preferred_starts_at;
  const end = proposal.proposed_ends_at ?? request.preferred_ends_at ?? new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
  const acceptedAt = new Date().toISOString();
  const { error: acceptError } = await db.from('tutoring_proposals').update({ status: 'accepted', updated_at: acceptedAt }).eq('id', proposal.id);
  if (acceptError) supabaseError('No se pudo aceptar la propuesta.', acceptError);
  await db.from('tutoring_proposals').update({ status: 'rejected', updated_at: acceptedAt }).eq('request_id', request.id).neq('id', proposal.id);
  const { error: requestError } = await db.from('tutoring_requests').update({ status: 'accepted', updated_at: acceptedAt }).eq('id', request.id);
  if (requestError) supabaseError('No se pudo actualizar la solicitud aceptada.', requestError);
  const { data: session, error: sessionError } = await db.from('tutoring_sessions').insert({
    request_id: request.id,
    accepted_proposal_id: proposal.id,
    student_id: request.student_id,
    tutor_id: proposal.tutor_id,
    subject_id: request.subject_id,
    starts_at: start,
    ends_at: end,
    modality: request.modality,
    location_text: request.location_text,
    meeting_url: request.meeting_url,
    status: 'scheduled',
  }).select('*').single();
  if (sessionError) supabaseError('La propuesta se aceptó, pero no se pudo crear la tutoría.', sessionError);
  const [studentContact, tutorContact] = await Promise.all([getAccountContact(request.student_id), getAccountContact(proposal.tutor_id)]);
  sendSessionConfirmedEmail(studentContact, { startsAt: start, role: 'student' });
  sendSessionConfirmedEmail(tutorContact, { startsAt: start, role: 'tutor' });
  return session;
};

export const handleApi = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    const url = urlFor(req);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') {
      throw new HttpError(404, 'NOT_FOUND', 'Ruta API no encontrada.');
    }

    if (req.method === 'GET' && parts[1] === 'health') {
      const { error } = await db.from('roles').select('id').limit(1);
      sendData(res, { status: error ? 'degraded' : 'ok', database: error ? 'error' : 'ok', service: 'tutoreshub-api' }, error ? 503 : 200);
      return;
    }

    if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'register') {
      sendData(res, await register(await readJson(req)), 201);
      return;
    }
    if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'login') {
      sendData(res, await login(await readJson(req)));
      return;
    }
    if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'refresh') {
      sendData(res, await refresh(await readJson(req)));
      return;
    }
    if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'forgot-password') {
      sendData(res, await requestPasswordReset(req, await readJson(req)));
      return;
    }
    if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'exchange-recovery-code') {
      sendData(res, await exchangeRecoveryCode(await readJson(req)));
      return;
    }
    if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'update-password') {
      sendData(res, await updatePassword(req, await readJson(req)));
      return;
    }

    if (req.method === 'GET' && parts[1] === 'me') {
      sendData(res, await currentUser(req));
      return;
    }

    if (req.method === 'GET' && parts[1] === 'subjects' && !parts[2]) {
      const { data, error } = await db.from('subjects').select('id, name, description').eq('is_active', true).order('name');
      if (error) supabaseError('No se pudieron consultar las materias.', error);
      sendData(res, data ?? []);
      return;
    }

    if (req.method === 'GET' && parts[1] === 'tutors' && !parts[2]) {
      sendData(res, await listTutors(url));
      return;
    }
    if (req.method === 'GET' && parts[1] === 'tutors' && parts[2] && parts[2] !== 'me') {
      sendData(res, await tutorDetail(idFrom(parts[2], 'tutorId')));
      return;
    }

    const user = await currentUser(req);
    if (req.method === 'PATCH' && parts[1] === 'me' && parts[2] === 'avatar') {
      const body = await readJson(req);
      sendData(res, await updateAvatar(user, body.dataUrl));
      return;
    }
    if (req.method === 'GET' && parts[1] === 'chat' && parts[2] === 'conversations' && !parts[3]) {
      requireRole(user, ['student', 'tutor']);
      const column = user.role === 'student' ? 'student_id' : 'tutor_id';
      const { data: conversations, error } = await db.from('chat_conversations').select('*').eq(column, user.id).order('updated_at', { ascending: false });
      if (error) supabaseError('No se pudieron consultar tus conversaciones.', error);
      const rows = conversations ?? [];
      const otherIds = rows.map((item) => user.role === 'student' ? item.tutor_id : item.student_id).filter(Boolean);
      const { data: accounts, error: accountError } = otherIds.length ? await db.from('users').select('id, full_name, email, avatar_url').in('id', otherIds) : { data: [], error: null };
      if (accountError) supabaseError('No se pudieron consultar los participantes del chat.', accountError);
      const accountById = new Map((accounts ?? []).map((account) => [account.id, account]));
      sendData(res, rows.map((conversation) => ({ ...conversation, other_user: accountById.get(user.role === 'student' ? conversation.tutor_id : conversation.student_id) || null })));
      return;
    }
    if (req.method === 'POST' && parts[1] === 'chat' && parts[2] === 'conversations' && !parts[3]) {
      requireRole(user, ['student', 'tutor']);
      const body = await readJson(req);
      const studentId = user.role === 'student' ? user.id : idFrom(String(body.studentId || ''), 'studentId');
      const tutorId = user.role === 'tutor' ? user.id : idFrom(String(body.tutorId || ''), 'tutorId');
      const requestId = body.requestId ? idFrom(String(body.requestId), 'requestId') : null;
      const { data, error } = await db.from('chat_conversations').upsert({ student_id: studentId, tutor_id: tutorId, request_id: requestId, updated_at: new Date().toISOString() }, { onConflict: 'student_id,tutor_id' }).select('*').single();
      if (error) supabaseError('No se pudo abrir el chat.', error, 409);
      sendData(res, data, 201);
      return;
    }
    if (req.method === 'GET' && parts[1] === 'chat' && parts[2] === 'conversations' && parts[3] && !parts[4]) {
      requireRole(user, ['student', 'tutor']);
      const conversationId = idFrom(parts[3], 'conversationId');
      const column = user.role === 'student' ? 'student_id' : 'tutor_id';
      const { data: conversation, error: conversationError } = await db.from('chat_conversations').select('*').eq('id', conversationId).eq(column, user.id).maybeSingle();
      if (conversationError) supabaseError('No se pudo consultar el chat.', conversationError);
      if (!conversation) throw new HttpError(404, 'CHAT_NOT_FOUND', 'La conversación no existe o no tienes acceso.');
      const { data: messages, error: messagesError } = await db.from('chat_messages').select('*').eq('conversation_id', conversationId).order('sent_at', { ascending: true });
      if (messagesError) supabaseError('No se pudieron consultar los mensajes.', messagesError);
      sendData(res, { ...conversation, messages: messages ?? [] });
      return;
    }
    if (req.method === 'POST' && parts[1] === 'chat' && parts[2] === 'conversations' && parts[3] && parts[4] === 'messages') {
      requireRole(user, ['student', 'tutor']);
      const conversationId = idFrom(parts[3], 'conversationId');
      const column = user.role === 'student' ? 'student_id' : 'tutor_id';
      const { data: conversation, error: conversationError } = await db.from('chat_conversations').select('*').eq('id', conversationId).eq(column, user.id).maybeSingle();
      if (conversationError) supabaseError('No se pudo validar el chat.', conversationError);
      if (!conversation) throw new HttpError(404, 'CHAT_NOT_FOUND', 'La conversación no existe o no tienes acceso.');
      const body = await readJson(req);
      const messageBody = requireString(body.body, 'body', 1, 2000);
      const { data: message, error: messageError } = await db.from('chat_messages').insert({ conversation_id: conversationId, sender_id: user.id, body: messageBody }).select('*').single();
      if (messageError) supabaseError('No se pudo guardar el mensaje.', messageError);
      await db.from('chat_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
      const otherId = user.role === 'student' ? conversation.tutor_id : conversation.student_id;
      try {
        const [recipient, sender] = await Promise.all([getAccountContact(otherId), getAccountContact(user.id)]);
        sendChatMessageEmail(recipient, { senderName: sender.fullName, body: messageBody });
      } catch (error) { console.error('chat_message_email_failed', error instanceof Error ? error.message : 'unknown error'); }
      sendData(res, message, 201);
      return;
    }

    const requireTutorAccess = async (): Promise<void> => {
      if (user.role === 'tutor') return;
      const { data: tutorProfile, error: tutorProfileError } = await db.from('tutor_profiles').select('user_id').eq('user_id', user.id).maybeSingle();
      if (tutorProfileError) supabaseError('No se pudo validar el perfil del profesor.', tutorProfileError);
      if (!tutorProfile) requireRole(user, ['tutor']);
    };
    if (req.method === 'GET' && parts[1] === 'subjects' && parts[2] === 'mine') {
      await requireTutorAccess();
      const { data, error } = await db.from('tutor_subjects').select('subject_id, hourly_rate, is_primary, subjects(id, name, description)').eq('tutor_id', user.id).order('is_primary', { ascending: false });
      if (error) supabaseError('No se pudieron consultar tus materias.', error);
      sendData(res, data ?? []);
      return;
    }
    if (req.method === 'POST' && parts[1] === 'subjects') {
      await requireTutorAccess();
      const body = await readJson(req);
      const name = requireString(body.name, 'name', 2, 100);
      const description = optionalString(body.description, 255) ?? null;
      const { data: existing, error: existingError } = await db.from('subjects').select('id, name, description').ilike('name', name).maybeSingle();
      if (existingError) supabaseError('No se pudo consultar la materia.', existingError);
      let subject = existing;
      if (!subject) {
        const { data, error } = await db.from('subjects').insert({ name, description, is_active: true }).select('id, name, description').single();
        if (error) supabaseError('No se pudo crear la materia.', error, 409);
        subject = data;
      }
      if (!subject) throw new HttpError(500, 'SUBJECT_NOT_CREATED', 'No se pudo preparar la materia.');
      const { data: relation, error: relationError } = await db.from('tutor_subjects').upsert({ tutor_id: user.id, subject_id: subject.id, hourly_rate: body.hourlyRate === undefined ? null : requireNumber(body.hourlyRate, 'hourlyRate', 0), is_primary: Boolean(body.isPrimary) }, { onConflict: 'tutor_id,subject_id' }).select('subject_id, hourly_rate, is_primary, subjects(id, name, description)').single();
      if (relationError) supabaseError('No se pudo asociar la materia al perfil.', relationError, 409);
      sendData(res, relation, 201);
      return;
    }
    if (req.method === 'DELETE' && parts[1] === 'subjects' && parts[2]) {
      await requireTutorAccess();
      const subjectId = requireNumber(parts[2], 'subjectId', 1);
      const { error } = await db.from('tutor_subjects').delete().eq('tutor_id', user.id).eq('subject_id', subjectId);
      if (error) supabaseError('No se pudo retirar la materia del perfil.', error);
      sendData(res, { deleted: true });
      return;
    }

    if (req.method === 'GET' && parts[1] === 'tutors' && parts[2] === 'me' && parts[3] === 'blogs' && !parts[4]) {
      requireRole(user, ['tutor']);
      const { data, error } = await db.from('tutor_blogs').select('*').eq('tutor_id', user.id).order('updated_at', { ascending: false });
      if (error) supabaseError('No se pudieron consultar tus blogs.', error);
      sendData(res, data ?? []);
      return;
    }
    if (req.method === 'POST' && parts[1] === 'tutors' && parts[2] === 'me' && parts[3] === 'blogs' && !parts[4]) {
      requireRole(user, ['tutor']);
      const body = await readJson(req);
      const title = requireString(body.title, 'title', 3, 180);
      const content = requireString(body.content, 'content', 20, 20000);
      const status = body.status === 'draft' ? 'draft' : 'published';
      const { data, error } = await db.from('tutor_blogs').insert({ tutor_id: user.id, title, content, status }).select('*').single();
      if (error) supabaseError('No se pudo crear el blog.', error);
      sendData(res, data, 201);
      return;
    }
    if ((req.method === 'PATCH' || req.method === 'PUT') && parts[1] === 'tutors' && parts[2] === 'me' && parts[3] === 'blogs' && parts[4]) {
      requireRole(user, ['tutor']);
      const blogId = idFrom(parts[4], 'blogId');
      const body = await readJson(req);
      const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.title !== undefined) payload.title = requireString(body.title, 'title', 3, 180);
      if (body.content !== undefined) payload.content = requireString(body.content, 'content', 20, 20000);
      if (body.status !== undefined) payload.status = ['draft', 'published', 'archived'].includes(String(body.status)) ? body.status : (() => { throw new HttpError(400, 'INVALID_BLOG_STATUS', 'El estado del blog no es válido.'); })();
      const { data, error } = await db.from('tutor_blogs').update(payload).eq('id', blogId).eq('tutor_id', user.id).select('*').maybeSingle();
      if (error) supabaseError('No se pudo actualizar el blog.', error);
      if (!data) throw new HttpError(404, 'BLOG_NOT_FOUND', 'El blog no existe o no pertenece a tu cuenta.');
      sendData(res, data);
      return;
    }
    if (req.method === 'DELETE' && parts[1] === 'tutors' && parts[2] === 'me' && parts[3] === 'blogs' && parts[4]) {
      requireRole(user, ['tutor']);
      const blogId = idFrom(parts[4], 'blogId');
      const { data, error } = await db.from('tutor_blogs').delete().eq('id', blogId).eq('tutor_id', user.id).select('id').maybeSingle();
      if (error) supabaseError('No se pudo eliminar el blog.', error);
      if (!data) throw new HttpError(404, 'BLOG_NOT_FOUND', 'El blog no existe o no pertenece a tu cuenta.');
      sendData(res, { deleted: true, id: data.id });
      return;
    }

    if (req.method === 'GET' && parts[1] === 'students' && parts[2] === 'me' && parts[3] === 'profile') {
      requireRole(user, ['student']);
      const [{ data: profile, error: profileError }, { data: account, error: accountError }] = await Promise.all([
        db.from('student_profiles').select('*').eq('user_id', user.id).maybeSingle(),
        db.from('users').select('id, email, full_name, phone, avatar_url, status').eq('id', user.id).single(),
      ]);
      if (profileError || accountError) supabaseError('No se pudo consultar tu cuenta.', profileError ?? accountError);
      sendData(res, { user: account, profile });
      return;
    }
    if (req.method === 'PATCH' && parts[1] === 'students' && parts[2] === 'me' && parts[3] === 'profile') {
      requireRole(user, ['student']);
      const body = await readJson(req);
      const accountPayload: Record<string, unknown> = {};
      if (body.fullName !== undefined) accountPayload.full_name = requireString(body.fullName, 'fullName', 2, 120);
      if (body.phone !== undefined) accountPayload.phone = optionalString(body.phone, 30) ?? null;
      if (Object.keys(accountPayload).length) {
        const { error } = await db.from('users').update(accountPayload).eq('id', user.id);
        if (error) supabaseError('No se pudo actualizar la información personal.', error);
      }
      const profilePayload: Record<string, unknown> = {};
      if (body.educationLevel !== undefined) profilePayload.education_level = optionalString(body.educationLevel, 80) ?? null;
      if (body.learningGoal !== undefined) profilePayload.learning_goal = optionalString(body.learningGoal, 160) ?? null;
      if (Object.keys(profilePayload).length) {
        const { error } = await db.from('student_profiles').update(profilePayload).eq('user_id', user.id);
        if (error) supabaseError('No se pudo actualizar tu perfil de estudiante.', error);
      }
      const [{ data: account }, { data: profile }] = await Promise.all([
        db.from('users').select('id, email, full_name, phone, avatar_url, status').eq('id', user.id).single(),
        db.from('student_profiles').select('*').eq('user_id', user.id).maybeSingle(),
      ]);
      sendData(res, { user: account, profile });
      return;
    }

    if (req.method === 'GET' && parts[1] === 'tutors' && parts[2] === 'me' && parts[3] === 'profile') {
      requireRole(user, ['tutor']);
      sendData(res, await tutorDetail(user.id));
      return;
    }
    if (req.method === 'GET' && parts[1] === 'tutors' && parts[2] === 'me' && parts[3] === 'metrics') {
      requireRole(user, ['tutor']);
      sendData(res, await tutorMetrics(user.id));
      return;
    }
    if (req.method === 'GET' && parts[1] === 'students' && parts[2] === 'me' && parts[3] === 'metrics') {
      requireRole(user, ['student']);
      sendData(res, await studentMetrics(user.id));
      return;
    }
    if ((req.method === 'PATCH' || req.method === 'PUT') && parts[1] === 'tutors' && parts[2] === 'me' && parts[3] === 'profile') {
      requireRole(user, ['tutor']);
      const body = await readJson(req);
      const accountPayload: Record<string, unknown> = {};
      if (body.fullName !== undefined) accountPayload.full_name = requireString(body.fullName, 'fullName', 2, 120);
      if (body.phone !== undefined) accountPayload.phone = optionalString(body.phone, 30) ?? null;
      if (Object.keys(accountPayload).length) {
        const { error } = await db.from('users').update(accountPayload).eq('id', user.id);
        if (error) supabaseError('No se pudo actualizar la información personal.', error);
      }
      const payload = {
        professional_title: optionalString(body.professionalTitle, 120),
        bio: optionalString(body.bio, 1000),
        years_experience: body.yearsExperience === undefined ? undefined : requireNumber(body.yearsExperience, 'yearsExperience', 0, 80),
        hourly_rate: body.hourlyRate === undefined ? undefined : requireNumber(body.hourlyRate, 'hourlyRate', 0, 1_000_000_000),
        currency: 'USD',
        teaching_modality: body.teachingModality,
        service_area: optionalString(body.serviceArea, 160),
      };
      const { data, error } = await db.from('tutor_profiles').update(payload).eq('user_id', user.id).select('*').single();
      if (error) supabaseError('No se pudo actualizar el perfil del tutor.', error);
      sendData(res, data);
      return;
    }
    if (req.method === 'GET' && parts[1] === 'tutors' && parts[2] === 'me' && parts[3] === 'availability') {
      requireRole(user, ['tutor']);
      const { data, error } = await db.from('tutor_availability_rules').select('*').eq('tutor_id', user.id).order('day_of_week').order('start_time');
      if (error) supabaseError('No se pudo consultar la disponibilidad.', error);
      sendData(res, data ?? []);
      return;
    }
    if (req.method === 'POST' && parts[1] === 'tutors' && parts[2] === 'me' && parts[3] === 'availability') {
      requireRole(user, ['tutor']);
      const body = await readJson(req);
      const dayOfWeek = requireNumber(body.dayOfWeek, 'dayOfWeek', 0, 6);
      const startTime = requireString(body.startTime, 'startTime', 4, 10);
      const endTime = requireString(body.endTime, 'endTime', 4, 10);
      if (endTime <= startTime) throw new HttpError(400, 'INVALID_TIME_RANGE', 'La hora final debe ser posterior a la hora inicial.');
      const modality = body.modality ?? 'both';
      if (!['online', 'in_person', 'both'].includes(String(modality))) throw new HttpError(400, 'INVALID_MODALITY', 'La modalidad no es válida.');
      const { data, error } = await db.from('tutor_availability_rules').insert({ tutor_id: user.id, day_of_week: dayOfWeek, start_time: startTime, end_time: endTime, modality }).select('*').single();
      if (error) supabaseError('No se pudo guardar la disponibilidad.', error);
      sendData(res, data, 201);
      return;
    }
    if ((req.method === 'PATCH' || req.method === 'DELETE') && parts[1] === 'tutors' && parts[2] === 'me' && parts[3] === 'availability' && parts[4]) {
      requireRole(user, ['tutor']);
      const availabilityId = idFrom(parts[4], 'availabilityId');
      if (req.method === 'DELETE') {
        const { error } = await db.from('tutor_availability_rules').delete().eq('id', availabilityId).eq('tutor_id', user.id);
        if (error) supabaseError('No se pudo eliminar el horario.', error);
        sendData(res, { id: availabilityId, deleted: true });
        return;
      }
      const body = await readJson(req);
      const dayOfWeek = requireNumber(body.dayOfWeek, 'dayOfWeek', 0, 6);
      const startTime = requireString(body.startTime, 'startTime', 4, 10);
      const endTime = requireString(body.endTime, 'endTime', 4, 10);
      if (endTime <= startTime) throw new HttpError(400, 'INVALID_TIME_RANGE', 'La hora final debe ser posterior a la hora inicial.');
      const modality = requireString(body.modality, 'modality', 5, 20);
      if (!['online', 'in_person'].includes(modality)) throw new HttpError(400, 'INVALID_MODALITY', 'La modalidad debe ser virtual o presencial.');
      const { data, error } = await db.from('tutor_availability_rules').update({ day_of_week: dayOfWeek, start_time: startTime, end_time: endTime, modality }).eq('id', availabilityId).eq('tutor_id', user.id).select('*').maybeSingle();
      if (error) supabaseError('No se pudo actualizar el horario.', error);
      if (!data) throw new HttpError(404, 'AVAILABILITY_NOT_FOUND', 'No se encontró ese horario en tu disponibilidad.');
      sendData(res, data);
      return;
    }

    if (req.method === 'GET' && parts[1] === 'requests' && !parts[2]) {
      if (user.role === 'student') {
        const { data, error } = await db.from('tutoring_requests').select('*').eq('student_id', user.id).in('status', ['submitted', 'negotiating']).order('created_at', { ascending: false });
        if (error) supabaseError('No se pudieron consultar tus solicitudes abiertas.', error);
        sendData(res, data ?? []);
      } else if (user.role === 'tutor') {
        const { data, error } = await db.from('tutoring_requests').select('*').in('status', ['submitted', 'negotiating']).or(`tutor_id.is.null,tutor_id.eq.${user.id}`).order('created_at', { ascending: false });
        if (error) supabaseError('No se pudieron consultar las solicitudes abiertas.', error);
        const requests = data ?? [];
        const studentIds = [...new Set(requests.map((request) => request.student_id).filter(Boolean))];
        const subjectIds = [...new Set(requests.map((request) => request.subject_id).filter(Boolean))];
        const educationLevelIds = [...new Set(requests.map((request) => request.education_level_id).filter(Boolean))];
        const [{ data: students, error: studentsError }, { data: subjects, error: subjectsError }, { data: educationLevels, error: educationLevelsError }] = await Promise.all([
          studentIds.length ? db.from('users').select('id, full_name, avatar_url').in('id', studentIds) : Promise.resolve({ data: [], error: null }),
          subjectIds.length ? db.from('subjects').select('id, name').in('id', subjectIds) : Promise.resolve({ data: [], error: null }),
          educationLevelIds.length ? db.from('education_levels').select('id, name').in('id', educationLevelIds) : Promise.resolve({ data: [], error: null }),
        ]);
        if (studentsError || subjectsError || educationLevelsError) supabaseError('No se pudo preparar la información de las solicitudes.', studentsError ?? subjectsError ?? educationLevelsError);
        const studentById = new Map((students ?? []).map((student) => [student.id, student]));
        const subjectById = new Map((subjects ?? []).map((subject) => [subject.id, subject]));
        const educationLevelById = new Map((educationLevels ?? []).map((level) => [level.id, level]));
        sendData(res, requests.map((request) => ({ ...request, student: studentById.get(request.student_id) ?? null, subject: subjectById.get(request.subject_id) ?? null, education_level: educationLevelById.get(request.education_level_id) ?? null })));
      } else {
        sendData(res, []);
      }
      return;
    }
    if (req.method === 'POST' && parts[1] === 'requests' && !parts[2]) {
      requireRole(user, ['student']);
      const body = await readJson(req);
      const modality = requireString(body.modality, 'modality', 5, 20);
      if (!['online', 'in_person'].includes(modality)) throw new HttpError(400, 'INVALID_MODALITY', 'La modalidad no es válida.');
      const preferredStartsAt = dateValue(body.preferredStartsAt, 'preferredStartsAt');
      const preferredEndsAt = body.preferredEndsAt ? dateValue(body.preferredEndsAt, 'preferredEndsAt') : null;
      if (preferredEndsAt && new Date(preferredEndsAt) <= new Date(preferredStartsAt)) throw new HttpError(400, 'INVALID_TIME_RANGE', 'La hora final debe ser posterior a la hora inicial.');
      if (preferredEndsAt) {
        const requestedHours = (new Date(preferredEndsAt).getTime() - new Date(preferredStartsAt).getTime()) / 3600000;
        if (!Number.isInteger(requestedHours)) throw new HttpError(400, 'INVALID_DURATION', 'La cantidad de horas debe ser un número entero.');
      }
      let tutorId: string | null = null;
      if (body.tutorId !== undefined && body.tutorId !== null && body.tutorId !== '') {
        tutorId = idFrom(String(body.tutorId), 'tutorId');
        const { data: tutor, error: tutorError } = await db.from('tutor_profiles').select('user_id').eq('user_id', tutorId).maybeSingle();
        if (tutorError) supabaseError('No se pudo validar el profesor seleccionado.', tutorError);
        if (!tutor) throw new HttpError(404, 'TUTOR_NOT_FOUND', 'El profesor seleccionado no existe.');
        const startDate = new Date(preferredStartsAt);
        const endDate = preferredEndsAt ? new Date(preferredEndsAt) : new Date(startDate.getTime() + 60 * 60 * 1000);
        const localParts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
        const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const startParts = localParts(startDate);
        const endParts = localParts(endDate);
        const dayOfWeek = weekdayMap[String(startParts.weekday)];
        const startMinutes = Number(startParts.hour) * 60 + Number(startParts.minute);
        const endMinutes = Number(endParts.hour) * 60 + Number(endParts.minute);
        const { data: rules, error: rulesError } = await db.from('tutor_availability_rules').select('day_of_week, start_time, end_time').eq('tutor_id', tutorId).eq('is_active', true).eq('day_of_week', dayOfWeek);
        if (rulesError) supabaseError('No se pudo validar el bloque del profesor.', rulesError);
        const fitsRule = (rules ?? []).some((rule) => { const [sh, sm] = String(rule.start_time).slice(0,5).split(':').map(Number); const [eh, em] = String(rule.end_time).slice(0,5).split(':').map(Number); return startMinutes >= sh*60+sm && endMinutes <= eh*60+em; });
        if ((rules ?? []).length && !fitsRule) throw new HttpError(400, 'OUTSIDE_AVAILABILITY', 'La fecha, hora y duración deben permanecer dentro del bloque seleccionado.');
      }
      const { data, error } = await db.from('tutoring_requests').insert({
        student_id: user.id,
        tutor_id: tutorId,
        subject_id: requireNumber(body.subjectId, 'subjectId', 1),
        education_level_id: body.educationLevelId === undefined ? null : requireNumber(body.educationLevelId, 'educationLevelId', 1),
        objective: requireString(body.objective, 'objective', 20, 1000),
        modality,
        preferred_starts_at: preferredStartsAt,
        preferred_ends_at: preferredEndsAt,
        location_text: optionalString(body.locationText, 255) ?? null,
        budget_per_hour: body.budgetPerHour === undefined ? null : requireNumber(body.budgetPerHour, 'budgetPerHour', 0),
        status: 'submitted',
      }).select('*').single();
      if (error) supabaseError('No se pudo crear la solicitud de tutoría.', error);
      sendRequestCreatedEmail(user, { objective: data.objective, modality: data.modality });
      sendData(res, data, 201);
      return;
    }
    if (req.method === 'GET' && parts[1] === 'requests' && parts[2] && !parts[3]) {
      const request = await getRequest(idFrom(parts[2], 'requestId'));
      if (user.role === 'student' && request.student_id !== user.id) throw new HttpError(403, 'FORBIDDEN', 'No puedes consultar esta solicitud.');
      if (user.role === 'tutor' && request.tutor_id && request.tutor_id !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Esta solicitud está dirigida a otro profesor.');
      const { data: proposals, error } = await db.from('tutoring_proposals').select('*').eq('request_id', request.id).order('created_at');
      if (error) supabaseError('No se pudieron consultar las propuestas.', error);
      sendData(res, { ...request, proposals: proposals ?? [] });
      return;
    }
    if (req.method === 'POST' && parts[1] === 'requests' && parts[2] && parts[3] === 'proposals') {
      requireRole(user, ['tutor']);
      const request = await getRequest(idFrom(parts[2], 'requestId'));
      if (request.tutor_id && request.tutor_id !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Esta solicitud está dirigida a otro profesor.');
      if (['accepted', 'cancelled', 'expired'].includes(request.status)) throw new HttpError(409, 'REQUEST_CLOSED', 'La solicitud ya no admite propuestas.');
      const body = await readJson(req);
      const { data, error } = await db.from('tutoring_proposals').insert({
        request_id: request.id,
        tutor_id: user.id,
        proposed_hourly_rate: requireNumber(body.proposedHourlyRate, 'proposedHourlyRate', 0),
        proposed_starts_at: body.proposedStartsAt ? dateValue(body.proposedStartsAt, 'proposedStartsAt') : null,
        proposed_ends_at: body.proposedEndsAt ? dateValue(body.proposedEndsAt, 'proposedEndsAt') : null,
        message: optionalString(body.message, 1000) ?? null,
        status: 'pending',
      }).select('*').single();
      if (error) supabaseError('No se pudo crear la propuesta. Puede que ya exista una propuesta de este tutor.', error, 409);
      await db.from('tutoring_requests').update({ status: 'negotiating', updated_at: new Date().toISOString() }).eq('id', request.id);
      sendProposalReceivedEmail(await getAccountContact(request.student_id), { message: data.message, proposedHourlyRate: Number(data.proposed_hourly_rate) });
      sendData(res, data, 201);
      return;
    }

    if (req.method === 'POST' && parts[1] === 'requests' && parts[2] && ['reject', 'rejection'].includes(parts[3] ?? '')) {
      requireRole(user, ['tutor']);
      const request = await getRequest(idFrom(parts[2], 'requestId'));
      if (request.tutor_id && request.tutor_id !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Esta solicitud está dirigida a otro profesor.');
      if (['accepted', 'cancelled', 'expired', 'rejected'].includes(request.status)) throw new HttpError(409, 'REQUEST_CLOSED', 'La solicitud ya no admite rechazo.');
      const body = await readJson(req);
      const reason = optionalString(body.reason, 255) ?? null;
      const now = new Date().toISOString();
      const { data, error } = await db.from('tutoring_requests').update({ status: 'rejected', rejection_reason: reason, updated_at: now }).eq('id', request.id).select('*').single();
      if (error) supabaseError('No se pudo rechazar la solicitud.', error);
      await db.from('tutoring_proposals').update({ status: 'rejected', updated_at: now }).eq('request_id', request.id).neq('status', 'accepted');
      try { sendRequestRejectedEmail(await getAccountContact(request.student_id), { objective: request.objective, reason }); } catch (emailError) { console.error('request_rejection_email_failed', emailError instanceof Error ? emailError.message : 'unknown error'); }
      sendData(res, data);
      return;
    }

    if (req.method === 'POST' && parts[1] === 'requests' && parts[2] && parts[3] === 'accept') {
      requireRole(user, ['tutor']);
      const request = await getRequest(idFrom(parts[2], 'requestId'));
      if (request.tutor_id && request.tutor_id !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Esta solicitud está dirigida a otro profesor.');
      if (['accepted', 'cancelled', 'expired'].includes(request.status)) throw new HttpError(409, 'REQUEST_CLOSED', 'La solicitud ya no admite aceptación.');
      const { data: existingProposal, error: existingProposalError } = await db.from('tutoring_proposals').select('*').eq('request_id', request.id).eq('tutor_id', user.id).maybeSingle();
      if (existingProposalError) supabaseError('No se pudo consultar la propuesta del profesor.', existingProposalError);
      let proposal = existingProposal;
      if (!proposal) {
        const { data: tutorProfile, error: tutorProfileError } = await db.from('tutor_profiles').select('hourly_rate').eq('user_id', user.id).single();
        if (tutorProfileError) supabaseError('No se pudo consultar la tarifa del profesor.', tutorProfileError);
        const rate = request.budget_per_hour ?? tutorProfile?.hourly_rate;
        if (rate === null || rate === undefined) throw new HttpError(422, 'RATE_REQUIRED', 'Define una tarifa en tu perfil antes de aceptar la oferta.');
        const start = request.preferred_starts_at;
        const end = request.preferred_ends_at ?? new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
        const { data, error } = await db.from('tutoring_proposals').insert({ request_id: request.id, tutor_id: user.id, proposed_hourly_rate: rate, proposed_starts_at: start, proposed_ends_at: end, message: 'Oferta del estudiante aceptada directamente por el profesor.', status: 'pending' }).select('*').single();
        if (error) supabaseError('No se pudo preparar la aceptación de la oferta.', error, 409);
        proposal = data;
      }
      sendData(res, await acceptProposalAndCreateSession(request, proposal), 201);
      return;
    }

    if (req.method === 'PATCH' && parts[1] === 'proposals' && parts[2]) {
      requireRole(user, ['student']);
      const proposal = await getProposal(idFrom(parts[2], 'proposalId'));
      const request = await getRequest(proposal.request_id);
      requireStudentOwner(user, request);
      const body = await readJson(req);
      const status = requireString(body.status, 'status', 6, 12);
      if (!['accepted', 'rejected'].includes(status)) throw new HttpError(400, 'INVALID_PROPOSAL_STATUS', 'El estado debe ser accepted o rejected.');
      if (status === 'rejected') {
        const { data, error } = await db.from('tutoring_proposals').update({ status: 'rejected', updated_at: new Date().toISOString() }).eq('id', proposal.id).select('*').single();
        if (error) supabaseError('No se pudo rechazar la propuesta.', error);
        sendData(res, data);
        return;
      }
      sendData(res, await acceptProposalAndCreateSession(request, proposal), 201);
      return;
    }

    if (req.method === 'GET' && parts[1] === 'sessions' && !parts[2]) {
      if (!['student', 'tutor'].includes(user.role)) throw new HttpError(403, 'FORBIDDEN', 'Solo estudiantes y tutores tienen tutorías.');
      const column = user.role === 'student' ? 'student_id' : 'tutor_id';
      const { data, error } = await db.from('tutoring_sessions').select('*').eq(column, user.id).order('starts_at', { ascending: true });
      if (error) supabaseError('No se pudieron consultar las tutorías.', error);
      sendData(res, data ?? []);
      return;
    }
    if (req.method === 'GET' && parts[1] === 'sessions' && parts[2] && parts[3] === 'meeting') {
      sendData(res, await getMeeting(user, idFrom(parts[2], 'sessionId')));
      return;
    }
    if (req.method === 'GET' && parts[1] === 'sessions' && parts[2] && !parts[3]) {
      const session = await getSession(idFrom(parts[2], 'sessionId'));
      requireSessionParticipant(user, session);
      const { data: participants, error: participantsError } = await db.from('users').select('id, full_name, email').in('id', [session.student_id, session.tutor_id]);
      if (participantsError) supabaseError('No se pudieron consultar los participantes.', participantsError);
      const participantById = new Map((participants ?? []).map((participant) => [participant.id, participant]));
      sendData(res, { ...session, student: participantById.get(session.student_id) || null, tutor: participantById.get(session.tutor_id) || null });
      return;
    }
    if (req.method === 'POST' && parts[1] === 'sessions' && parts[2] && parts[3] === 'finish') {
      const session = await getSession(idFrom(parts[2], 'sessionId'));
      requireSessionParticipant(user, session);
      if (session.status === 'cancelled') throw new HttpError(409, 'SESSION_CANCELLED', 'La tutoría está cancelada.');
      if (session.status === 'completed') { sendData(res, session); return; }
      const { data, error } = await db.from('tutoring_sessions').update({ status: 'review_pending', updated_at: new Date().toISOString() }).eq('id', session.id).in('status', ['scheduled', 'in_progress', 'review_pending']).select('*').single();
      if (error) supabaseError('No se pudo marcar la tutoría como pendiente de reseña.', error);
      sendData(res, data);
      return;
    }

    if (req.method === 'POST' && parts[1] === 'sessions' && parts[2] && parts[3] === 'cancel') {
      const session = await getSession(idFrom(parts[2], 'sessionId'));
      requireSessionParticipant(user, session);
      if (['completed', 'cancelled'].includes(session.status)) throw new HttpError(409, 'SESSION_CLOSED', 'La tutoría ya está cerrada.');
      const body = await readJson(req);
      const reason = requireString(body.reason, 'reason', 3, 255);
      const { data, error } = await db.from('tutoring_sessions').update({ status: 'cancelled', cancellation_reason: reason, updated_at: new Date().toISOString() }).eq('id', session.id).select('*').single();
      if (error) supabaseError('No se pudo cancelar la tutoría.', error);
      const otherPartyId = user.id === session.student_id ? session.tutor_id : session.student_id;
      try {
        const contact = await getAccountContact(otherPartyId);
        sendSessionCancelledEmail(contact, { startsAt: session.starts_at, reason, cancelledBy: user.role });
      } catch (error) {
        console.error('session_cancellation_email_failed', error instanceof Error ? error.message : 'unknown error');
      }
      sendData(res, data);
      return;
    }

    if (req.method === 'POST' && parts[1] === 'sessions' && parts[2] && parts[3] === 'reviews') {
      requireRole(user, ['student']);
      const session = await getSession(idFrom(parts[2], 'sessionId'));
      if (session.student_id !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Solo el estudiante participante puede reseñar esta tutoría.');
      if (session.status !== 'review_pending') throw new HttpError(409, 'SESSION_NOT_READY_FOR_REVIEW', 'Primero marca la tutoría como pendiente de reseña desde el aula virtual.');
      const body = await readJson(req);
      const rating = requireNumber(body.rating, 'rating', 1, 5);
      const { data, error } = await db.from('tutor_reviews').insert({ session_id: session.id, student_id: user.id, tutor_id: session.tutor_id, rating, comment: optionalString(body.comment, 1000) ?? null }).select('*').single();
      if (error) supabaseError('No se pudo publicar la reseña.', error, 409);
      const { data: completed, error: completeError } = await db.from('tutoring_sessions').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', session.id).select('*').single();
      if (completeError) supabaseError('La reseña se guardó, pero no se pudo cerrar la tutoría.', completeError);
      const { data: reviewStats, error: reviewStatsError } = await db.from('tutor_reviews').select('rating').eq('tutor_id', session.tutor_id).eq('is_published', true);
      if (!reviewStatsError && reviewStats) {
        const count = reviewStats.length;
        const average = count ? Number((reviewStats.reduce((sum, item) => sum + Number(item.rating), 0) / count).toFixed(1)) : 0;
        await db.from('tutor_profiles').update({ review_count: count, average_rating: average, updated_at: new Date().toISOString() }).eq('user_id', session.tutor_id);
      }
      sendData(res, { review: data, session: completed }, 201);
      return;
    }

    if (req.method === 'GET' && parts[1] === 'ai' && parts[2] === 'conversations' && !parts[3]) {
      requireRole(user, ['student']);
      const { data, error } = await db.from('ai_conversations').select('*').eq('student_id', user.id).order('updated_at', { ascending: false });
      if (error) supabaseError('No se pudieron consultar las conversaciones del Asistente IA.', error);
      sendData(res, data ?? []);
      return;
    }
    if (req.method === 'POST' && parts[1] === 'ai' && parts[2] === 'conversations' && !parts[3]) {
      requireRole(user, ['student']);
      const body = await readJson(req);
      const { data, error } = await db.from('ai_conversations').insert({ student_id: user.id, title: optionalString(body.title, 160) ?? 'Nueva conversación' }).select('*').single();
      if (error) supabaseError('No se pudo crear la conversación del Asistente IA.', error);
      sendData(res, data, 201);
      return;
    }
    if (req.method === 'GET' && parts[1] === 'ai' && parts[2] === 'conversations' && parts[3]) {
      requireRole(user, ['student']);
      const conversationId = idFrom(parts[3], 'conversationId');
      const { data: conversation, error: conversationError } = await db.from('ai_conversations').select('*').eq('id', conversationId).eq('student_id', user.id).maybeSingle();
      if (conversationError) supabaseError('No se pudo consultar la conversación.', conversationError);
      if (!conversation) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', 'La conversación no existe.');
      const { data: messages, error: messagesError } = await db.from('ai_messages').select('*').eq('conversation_id', conversationId).order('created_at');
      if (messagesError) supabaseError('No se pudieron consultar los mensajes.', messagesError);
      sendData(res, { ...conversation, messages: messages ?? [] });
      return;
    }
    if (req.method === 'POST' && parts[1] === 'ai' && parts[2] === 'conversations' && parts[3] && parts[4] === 'messages') {
      requireRole(user, ['student']);
      const conversationId = idFrom(parts[3], 'conversationId');
      const { data: conversation, error: conversationError } = await db.from('ai_conversations').select('id').eq('id', conversationId).eq('student_id', user.id).maybeSingle();
      if (conversationError) supabaseError('No se pudo validar la conversación.', conversationError);
      if (!conversation) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', 'La conversación no existe.');
      const body = await readJson(req);
      const content = requireString(body.content, 'content', 1, 5000);
      const { data: history, error: historyError } = await db.from('ai_messages').select('role, content').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(20);
      if (historyError) supabaseError('No se pudo consultar el contexto de la conversación.', historyError);
      const { data: userMessage, error } = await db.from('ai_messages').insert({ conversation_id: conversationId, role: 'user', content }).select('*').single();
      if (error) supabaseError('No se pudo guardar el mensaje.', error);
      const messages: AssistantMessage[] = [...(history ?? []), { role: 'user', content }].map((message) => ({ role: message.role as AssistantMessage['role'], content: message.content as string }));
      const reply = await generateAssistantReply(messages);
      const { data: assistantMessage, error: assistantError } = await db.from('ai_messages').insert({ conversation_id: conversationId, role: 'assistant', content: reply.content, model_name: reply.model }).select('*').single();
      if (assistantError) supabaseError('La respuesta llegó, pero no se pudo guardar en la conversación.', assistantError);
      await db.from('ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
      sendData(res, { message: userMessage, assistant: assistantMessage, model: reply.model }, 201);
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'Ruta API no encontrada.');
  } catch (error) {
    sendError(res, error);
  }
};
