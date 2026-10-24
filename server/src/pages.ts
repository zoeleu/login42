import { Hono } from "hono";
import { escapeHtml, page } from "./lib/util";

// Public pages: landing page and the privacy policy (Portuguese at /privacidade, English at /privacy).
// Keep both language versions in sync with each other and with the actual retention in the code.
export const pages = new Hono<{ Bindings: Env }>();

const UPDATED = "2026-10-24";
const contact = (env: Env, missing: string) => (env.PRIVACY_CONTACT ? escapeHtml(env.PRIVACY_CONTACT) : `<em>${missing}</em>`);
const host = (env: Env) => escapeHtml(new URL(env.PUBLIC_URL).hostname);

pages.get("/", (c) => {
	const body = `A Minecraft server for current 42 students. / Um servidor de Minecraft para estudantes da 42.</p>
<h2>Play</h2>
<p>Connect to <code>${host(c.env)}</code> with Minecraft Java Edition 1.20.5 or newer. The first time, the game shows a link: sign in with your 42 account and you enter as your 42 login. If you own the game, type <code>/premium</code> in game to link your Mojang account and skip the browser next time.</p>
<p><a href="/me" style="display:inline-block;padding:.7rem 1rem;background:#007f82;color:white;text-decoration:none;border-radius:.3rem">Sign in with 42 to manage your account</a></p>
<h2>Pages</h2>
<ul>
<li><a href="/me">Your account</a>: skin, premium link, sign out, account deletion</li>
<li><a href="/privacy">Privacy policy</a> (English)</li>
<li><a href="/privacidade">Política de privacidade</a> (português)</li>
</ul><p>`;
	return c.html(page("42craft", body));
});

pages.get("/privacidade", (c) => {
	const body = `Última atualização: ${UPDATED}. <a href="/privacy">English version</a>.</p>
<h2>1. Quem é o controlador</h2>
<p>O servidor 42craft (<code>${host(c.env)}</code>) e este site são operados pela sua administração, que é a controladora dos dados pessoais descritos aqui, nos termos da Lei Geral de Proteção de Dados (LGPD, Lei nº 13.709/2018). Contato para assuntos de privacidade e exercício de direitos: ${contact(c.env, "(contato ainda não configurado)")}.</p>
<h2>2. Dados que tratamos</h2>
<ul>
<li><b>Conta 42:</b> identificador numérico, login, título selecionado na Intra e, apenas no momento do login, situação de estudante (para verificar elegibilidade; não armazenamos esses indicadores).</li>
<li><b>Identidade no jogo:</b> nome e UUID de Minecraft derivados da conta 42; conta Mojang/Microsoft vinculada (UUID e nome) e texturas de skin, se você vincular ou enviar uma.</li>
<li><b>Registros de acesso:</b> data e hora; endereço IP (da conexão com o jogo ou do navegador); nome de usuário da 42 e do jogo; nome e UUID informados pelo cliente de Minecraft; endereço do servidor usado; navegador (user agent) no login web; identidade Mojang verificada; e o <em>hash</em> SHA-256 do token de login de uso único (nunca o token em si, que não pode ser reconstruído a partir do hash).</li>
<li><b>Moderação:</b> banimentos e seus motivos, e um histórico de ações administrativas.</li>
<li><b>Servidor de jogo:</b> mensagens de chat, comandos, conexões (com IP) e ações no mundo (blocos e itens, registradas por ferramenta de auditoria do jogo), além do progresso salvo (inventário, posição).</li>
<li><b>Cookies:</b> um cookie de sessão (<code>login42_sid</code>, até 8 horas) para as páginas da sua conta, e cookies de transferência do próprio Minecraft com tokens de uso único (até 2 minutos). Não usamos cookies de publicidade ou de análise.</li>
</ul>
<h2>3. Finalidades e base legal</h2>
<p>Tratamos esses dados com base no <b>legítimo interesse</b> (art. 7º, IX, e art. 10 da LGPD), para: permitir o acesso apenas a estudantes da 42 elegíveis; manter a segurança das contas e do servidor; prevenir e apurar abusos, fraudes, uso indevido de contas, assédio, discriminação e outros ilícitos; e aplicar banimentos. <b>Não pedimos consentimento</b>, pois o tratamento é necessário para essas finalidades e se limita ao mínimo necessário. Você pode se opor ao tratamento (seção 7); como o serviço não funciona sem ele, a oposição normalmente implica a exclusão da conta.</p>
<h2>4. Compartilhamento</h2>
<ul>
<li><b>42 (Intra):</b> usamos a API da 42 para autenticar você. Em caso de abuso, ilícito ou discriminação praticados por estudantes, podemos compartilhar os registros pertinentes com a administração da 42 para apuração disciplinar.</li>
<li><b>Autoridades:</b> quando exigido por lei ou ordem judicial, ou para o exercício regular de direitos.</li>
<li><b>Operadores:</b> Cloudflare (hospedagem do site e do banco de dados), o provedor de hospedagem do servidor de jogo, Mojang/Microsoft (verificação de contas e skins) e MineSkin (apenas se você enviar uma skin).</li>
</ul>
<p>Não vendemos dados nem os usamos para publicidade.</p>
<h2>5. Transferência internacional</h2>
<p>Cloudflare, Microsoft e MineSkin podem tratar dados fora do Brasil. Essas transferências são necessárias para prestar o serviço e seguem o art. 33 da LGPD.</p>
<h2>6. Por quanto tempo guardamos</h2>
<ul>
<li>Tokens de login: até 2 minutos. Sessões web: até 8 horas. Links e códigos de vinculação: até 10 minutos.</li>
<li>Limites de tentativas: minutos, com o IP armazenado apenas em forma de hash.</li>
<li>Conta, skin e vínculo premium: enquanto a conta existir.</li>
<li><b>Registros de acesso:</b> enquanto a conta existir e por <b>6 meses após a exclusão da conta</b>; depois disso, os dados pessoais desses registros são apagados (resta apenas a informação de que existiu um registro, para manter a integridade da trilha de auditoria).</li>
<li>Banimentos: enquanto durar o banimento. Uma conta banida não pode ser excluída pelo próprio usuário.</li>
<li>Registros do servidor de jogo (chat, comandos, conexões, ações no mundo): enquanto forem necessários para a moderação e a operação do servidor; o prazo de 6 meses acima não se aplica a eles. O progresso salvo no mundo permanece com o mundo do servidor.</li>
<li>Dados podem ser guardados por mais tempo quando necessários a uma apuração em andamento ou exigidos por lei.</li>
</ul>
<h2>7. Seus direitos</h2>
<p>Você pode solicitar, nos termos do art. 18 da LGPD: confirmação e acesso aos seus dados; correção; anonimização, bloqueio ou eliminação de dados desnecessários ou excessivos; portabilidade; informação sobre compartilhamento; e oposição ao tratamento. Você mesmo pode <a href="/me">excluir sua conta</a> a qualquer momento. Para os demais pedidos, use o contato da seção 1. Você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).</p>
<h2>8. Segurança</h2>
<p>Tokens são aleatórios, de uso único e armazenados apenas como hash. A comunicação entre o servidor de jogo e o site é autenticada. Os registros de acesso formam uma cadeia de hashes que torna detectáveis alterações posteriores, e o acesso a eles é restrito à administração.</p>
<h2>9. Alterações</h2>
<p>Podemos atualizar esta política. A data no topo indica a versão em vigor.`;
	return c.html(page("Política de privacidade", body).replace("<!doctype html>", '<!doctype html><html lang="pt-BR">'));
});

pages.get("/privacy", (c) => {
	const body = `Last updated: ${UPDATED}. <a href="/privacidade">Versão em português</a> (the Portuguese version prevails in case of discrepancy).</p>
<h2>1. Controller</h2>
<p>The 42craft server (<code>${host(c.env)}</code>) and this website are run by its administrators, who are the controller of the personal data described here under Brazil's General Data Protection Law (LGPD, Law 13.709/2018). Privacy contact and data subject requests: ${contact(c.env, "(contact not yet configured)")}.</p>
<h2>2. Data we process</h2>
<ul>
<li><b>42 account:</b> numeric ID, login, selected Intra title and, only while you sign in, your student status (to check eligibility; these flags are not stored).</li>
<li><b>In-game identity:</b> Minecraft name and UUID derived from your 42 account; the linked Mojang/Microsoft account (UUID and name) and skin textures, if you link or upload one.</li>
<li><b>Access records:</b> date and time; IP address (of the game connection or browser); 42 and in-game usernames; the name and UUID claimed by the Minecraft client; the server address used; browser user agent on web sign-in; verified Mojang identity; and the SHA-256 <em>hash</em> of the one-time login token (never the token itself, which cannot be recovered from the hash).</li>
<li><b>Moderation:</b> bans and their reasons, and a history of administrative actions.</li>
<li><b>Game server:</b> chat messages, commands, connections (with IP) and world actions (blocks and items, recorded by an in-game audit tool), plus saved progress (inventory, position).</li>
<li><b>Cookies:</b> a session cookie (<code>login42_sid</code>, up to 8 hours) for your account pages, and Minecraft's own transfer cookies carrying one-time tokens (up to 2 minutes). No advertising or analytics cookies.</li>
</ul>
<h2>3. Purposes and legal basis</h2>
<p>We process this data on the basis of <b>legitimate interest</b> (LGPD art. 7, IX, and art. 10) to: admit only eligible 42 students; keep accounts and the server secure; prevent and investigate abuse, fraud, account misuse, harassment, discrimination and other unlawful conduct; and enforce bans. <b>We do not ask for consent</b>: processing is necessary for these purposes and limited to what they require. You may object (section 7); since the service cannot work without it, objecting normally means deleting your account.</p>
<h2>4. Sharing</h2>
<ul>
<li><b>42 (Intra):</b> we use 42's API to authenticate you. Where students commit abuse, unlawful acts or discrimination, we may share the relevant records with 42's administration for disciplinary review.</li>
<li><b>Authorities:</b> when required by law or court order, or to exercise legal rights.</li>
<li><b>Processors:</b> Cloudflare (website and database hosting), the game server hosting provider, Mojang/Microsoft (account and skin verification) and MineSkin (only if you upload a skin).</li>
</ul>
<p>We do not sell data or use it for advertising.</p>
<h2>5. International transfers</h2>
<p>Cloudflare, Microsoft and MineSkin may process data outside Brazil. These transfers are necessary to provide the service and follow LGPD art. 33.</p>
<h2>6. Retention</h2>
<ul>
<li>Login tokens: up to 2 minutes. Web sessions: up to 8 hours. Sign-in links and linking codes: up to 10 minutes.</li>
<li>Rate-limit counters: minutes, with IPs stored only as a hash.</li>
<li>Account, skin and premium link: while the account exists.</li>
<li><b>Access records:</b> while the account exists and for <b>6 months after account deletion</b>; then their personal data is erased (only the fact that a record existed remains, to keep the audit trail's integrity).</li>
<li>Bans: while the ban lasts. A banned account cannot be self-deleted.</li>
<li>Game server records (chat, commands, connections, world actions): for as long as needed to moderate and operate the server; the 6-month period above does not apply to them. Saved progress stays with the server's world.</li>
<li>Data may be kept longer when needed for an ongoing investigation or required by law.</li>
</ul>
<h2>7. Your rights</h2>
<p>Under LGPD art. 18 you may request: confirmation of and access to your data; correction; anonymization, blocking or deletion of unnecessary or excessive data; portability; information about sharing; and objection to processing. You can <a href="/me">delete your account</a> yourself at any time. For other requests, use the contact in section 1. You may also complain to Brazil's data protection authority (ANPD).</p>
<h2>8. Security</h2>
<p>Tokens are random, single-use and stored only as hashes. Communication between the game server and this website is authenticated. Access records form a hash chain that makes later alterations detectable, and access to them is restricted to administrators.</p>
<h2>9. Changes</h2>
<p>We may update this policy. The date at the top shows the version in force.`;
	return c.html(page("Privacy policy", body));
});
