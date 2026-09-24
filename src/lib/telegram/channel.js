import { renderRss2 } from '../../utils/util';
import { substr } from 'runes2';

// 相对协议/相对路径的链接补全为绝对地址
const absUrl = (href) => {
	if (!href) return '';
	if (href.startsWith('//')) return 'https:' + href;
	if (href.startsWith('/')) return 'https://t.me' + href;
	return href;
};

// HTMLRewriter 的 text/attribute 是未解码的原始字符，这里做一层实体解码
const namedEntities = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
	hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”',
	lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»', middot: '·',
	deg: '°', times: '×', plusmn: '±', euro: '€', pound: '£', yen: '¥',
	copy: '©', reg: '®', trade: '™',
};
const decodeEntities = (s) =>
	s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
		if (body[0] === '#') {
			let code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
		}
		return body in namedEntities ? namedEntities[body] : m;
	});

// 解析 t.me/s/<username> 页面 HTML，输出与 RSSHub telegram/channel 路由对齐的结构：
// - 标题带媒体前缀 emoji：↩️ 回复 / 🎬 视频 / 🖼 图片
// - 描述保留 <a href>、<b>、<blockquote>、<br>、<img>
// - 回复消息渲染为 <p><a href="被回复消息"><b>作者:</b></a></p><blockquote>引用摘要</blockquote>
// - pubDate 为 RFC822 (toUTCString)
export const parseChannelPage = async (html, username) => {
	let title = '';
	let description = '';
	let texts = []; // 每条消息的 description html（按页面 DOM 顺序，最新在前）
	let dates = [];
	let links = [];
	let metas = []; // 每条消息的媒体标记 { photo, video, reply, replyAuthor }

	let pushText = (t) => {
		if (texts.length) texts[texts.length - 1] += t;
	};
	let lastMeta = () => (metas.length ? metas[metas.length - 1] : null);

	let stream = new HTMLRewriter()
		.on('head > title', {
			text(text) {
				title += text.text;
			},
		})
		.on('head > meta[property="og:description"]', {
			element(element) {
				description += element.getAttribute('content');
			},
		})
		.on('.tgme_widget_message_wrap > .tgme_widget_message', {
			element(element) {
				// data-post 形如 "GodlyNews1/16274"，自身已含频道名
				links.push(`https://t.me/${element.getAttribute('data-post')}`);
			},
		})
		.on('.tgme_widget_message_date > time', {
			element(element) {
				dates.push(element.getAttribute('datetime'));
			},
		})
		.on('.tgme_widget_message_bubble', {
			element() {
				texts.push('');
				metas.push({ photo: false, video: false, reply: false, replyAuthor: false });
			},
		})
		// 图片（相册每张一个 photo_wrap，逐张插入）
		.on('.tgme_widget_message_bubble .tgme_widget_message_photo_wrap', {
			element(element) {
				let meta = lastMeta();
				if (!meta) return;
				meta.photo = true;
				let m = (element.getAttribute('style') || '').match(/background-image:url\('([^']+)'\)/);
				if (m) pushText(`<img src="${m[1]}" /><br>`);
			},
		})
		.on('.tgme_widget_message_bubble .tgme_widget_message_video_wrap', {
			element() {
				let meta = lastMeta();
				if (meta) meta.video = true;
			},
		})
		// 回复块开头：<p><a href="被回复消息"><b>（作者名在后的 closure 补全）
		.on('.tgme_widget_message_bubble .tgme_widget_message_reply', {
			element(element) {
				let meta = lastMeta();
				if (!meta) return;
				meta.reply = true;
				pushText(`<p><a href="${absUrl(element.getAttribute('href'))}"><b>`);
				element.onEndTag(() => {
					if (meta.replyAuthor) {
						pushText('</blockquote>');
					} else {
						pushText('</b></a></p>');
					}
				});
			},
		})
		// 回复的作者名，闭合时收尾进入引用块
		.on('.tgme_widget_message_bubble .tgme_widget_message_reply .tgme_widget_message_author_name', {
			text(text) {
				pushText(text.text);
			},
			element(element) {
				element.onEndTag(() => {
					let meta = lastMeta();
					if (!meta || !meta.reply || meta.replyAuthor) return;
					meta.replyAuthor = true;
					pushText(':</b></a></p><blockquote>');
				});
			},
		})
		// 正文文本（回复摘要与正文按文档顺序都经过该 handler）
		.on('.tgme_widget_message_bubble .tgme_widget_message_text', {
			text(text) {
				pushText(text.text);
			},
		})
		// 超链接（含标签 #xxx、@频道、外链）
		.on('.tgme_widget_message_bubble .tgme_widget_message_text a', {
			element(element) {
				pushText(`<a href="${absUrl(element.getAttribute('href'))}">`);
				element.onEndTag(() => pushText('</a>'));
			},
		})
		// 粗体：顶层或链接内（emoji 的 <b> 位于 <i> 内，不会命中 > 组合器）
		.on('.tgme_widget_message_bubble .tgme_widget_message_text > b', {
			element(element) {
				pushText('<b>');
				element.onEndTag(() => pushText('</b>'));
			},
		})
		.on('.tgme_widget_message_bubble .tgme_widget_message_text a > b', {
			element(element) {
				pushText('<b>');
				element.onEndTag(() => pushText('</b>'));
			},
		})
		.on('.tgme_widget_message_bubble .tgme_widget_message_text br', {
			element() {
				pushText('<br>');
			},
		})
		.on('.tgme_widget_message_bubble .tgme_widget_message_text blockquote', {
			element(element) {
				pushText('<blockquote>');
				element.onEndTag(() => pushText('</blockquote>'));
			},
		})
		.transform(new Response(html));
	await stream.text();

	// 标题取正文第一行纯文本（与 RSSHub 一致，回复块不参与标题）
	const stripReplyPrefix = (s) => {
		let m = s.match(/^<p><a href="[^"]*"><b>[\s\S]*?<\/b><\/a><\/p><blockquote>[\s\S]*?<\/blockquote>/);
		return m ? s.slice(m[0].length) : s;
	};
	// 先去标签再解码，避免正文中真实的 < > 干扰去标签
	const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, '').trim());

	let items = [];
	for (let i = 0; i < texts.length; i++) {
		let html = texts[i];
		if (html.trim() === '') continue;
		let meta = metas[i];
		let mainHtml = stripReplyPrefix(html);
		let firstLine = mainHtml.split(/<br\s*\/?>/).map(stripTags).find((s) => s.length > 0) || '';
		let plain = firstLine || stripTags(mainHtml);
		let emoji = '';
		if (meta.reply) emoji += '↩️';
		if (meta.video) emoji += '🎬';
		if (meta.photo) emoji += '🖼';
		let t = plain.length > 100 ? substr(plain, 0, 100) + '...' : plain;
		if (t.trim().length === 0) t = '无标题';
		items.push({
			title: (emoji ? emoji + ' ' : '') + t,
			link: links[i] || `https://t.me/${username}`,
			description: decodeEntities(html),
			pubDate: dates[i] ? new Date(dates[i]).toUTCString() : '',
		});
	}

	return { title, description, items };
};

let deal = async (ctx) => {
	const { username } = ctx.req.param();
	let res = await fetch(`https://t.me/s/${username}`);
	let html = await res.text();
	let { title, description, items } = await parseChannelPage(html, username);
	let data = {
		title: title,
		link: `https://t.me/s/${username}`,
		description: description,
		language: 'zh-cn',
		items: items,
	};
	ctx.header('Content-Type', 'application/xml');
	return ctx.body(renderRss2(data));
};

let setup = (route) => {
	route.get('/telegram/channel/:username', deal);
};

export default { setup };
