// Local outbox entries remain visible until their exact server nonce is observed.
export function mergePendingMessages(messages, pending) {
  if (!pending) return messages;
  if (messages.some(message => (pending.id && message.id === pending.id) || (pending.clientNonceHash && message.clientNonceHash === pending.clientNonceHash))) return messages;
  return [...messages, pending];
}
function openingReply(value) {
  let text = String(value || '').trim().replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*(?:안내|답변|응답|결과|처리 결과|Notice|Response|Result)\s*\n/i, '').trimStart();
  // Quoted errors, logs, and example code describe data rather than an outcome.
  if (/^(?:>|```|~~~|["'“‘「])/.test(text)) return '';
  text = text.replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」/g, '')
    // Apostrophes inside English contractions are not quotation marks.
    .replace(/(^|[\s:(])'[^'\n]*'(?=$|[\s.,:;!?])/g, '$1');
  const lines = text.split(/[\n.!?。]+/).map(line => line.trim()).filter(Boolean);
  let opening = lines[0] || '';
  const apology = /^(?:(?:정말|매우)\s*)?(?:죄송합니다만|죄송하지만|죄송합니다|죄송해요|미안하지만|미안합니다|미안해요|아쉽지만|안타깝지만|I(?:'m| am) sorry|Sorry|Unfortunately|Regrettably)(?:[\s,:，—–-]+|$)(?:but\s+)?/i;
  opening = opening.replace(apology, '').trim();
  if (!opening) opening = (lines[1] || '').replace(apology, '').trim();
  return opening.slice(0, 300);
}
function isFailedReply(message) {
  const text = String(message.text || '').trim();
  if (message.kind === 'system') return /답변.*(?:못했|실패|완료하지 못|반환하지 않)|모델.*(?:없습니다|제한)|요청.*완료하지 못/.test(text);
  const opening = openingReply(text);
  // A repaired error or a conditional example must not leave the agent red.
  if (/(?:해결|복구|수정|완료|성공)(?:했|됐|되었|하였습니다|했습니다)|(?:문구|오류\s*메시지).*(?:의미|뜻)|(?:라고|라는).*(?:답했|답변했|안내했|말했|설명|표시|적었)|(?:없다|못한다)고\s*(?:했|답했|답변했|안내했|말했)|(?:경우|때에는|때는|다면|하면|없어도|없더라도)/.test(opening)) return false;
  // Polite refusals use several different Korean verb endings; matching only
  // "할 수 없다" misses the common "도와드릴 수 없다" and "도움을 드릴 수 없다".
  return /(?:도와드릴|도와줄|도울|도움을?\s*(?:드릴|줄)|(?:지원|안내|답변|응답|제공|처리|실행)해\s*드릴|답변드릴|수행할|진행할|답변할|응답할|제공할|처리할|실행할|접근할|확인할|조회할|읽을|보낼|사용할|응할|할)\s*수(?:는|가|도)?\s*(?:없습니다|없어요|없다|없어|없네요)/.test(opening) ||
    /접근할\s*권한이\s*(?:없습니다|없어요)|(?:제공|지원)(?:하지|되지|되어 있지)\s*(?:않습니다|않아요)|완료하지\s*(?:못했습니다|못했어요)|불가능(?:합니다|해요)/.test(opening) ||
    /(?:도와드리|도와주|돕|답변드리|답변하|제공하|지원하|처리하|실행하|수행하)기(?:는|가|도)?\s*어렵(?:습니다|어요)|(?:도와드리|도와주|지원하|처리하|실행하|제공하|답변하|수행하)지\s*(?:못합니다|못해요|않겠습니다)/.test(opening) ||
    /(?:작업|요청|처리|실행|응답|답변).{0,40}(?:실패했습니다|실패했어요)|오류가\s*발생(?:했습니다|했어요)/.test(opening) ||
    /^(?:(?:I|we)\s+(?:cannot|can't|can not|am unable to|are unable to|am not able to|are not able to)|I(?:'m| am)\s+(?:unable|not able|not allowed)\s+to|we(?:'re| are)\s+(?:unable|not able|not allowed)\s+to|(?:this|that|your|the)\s+request\s+(?:cannot|can't)\s+be\s+(?:fulfilled|processed|completed))/i.test(opening);
}
export function failedOutcome(messages = []) {
  let human = null, replies = [];
  for (const message of messages) {
    if (message.kind === 'human') { human = message.id; replies = []; }
    else if (message.kind === 'bot' || message.kind === 'system') replies.push(message);
  }
  const failure = replies.find(isFailedReply);
  return {humanId:human, failed:Boolean(failure), messageId:failure?.id || null};
}
