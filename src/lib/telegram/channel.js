import { renderRss2 } from '../../utils/util';
import { substr } from 'runes2';

// 相对协议/相对路径的链接补全为绝对地址；?query 形式（标签链接）相对当前消息地址
const absUrl = (href, base) => {
	if (!href) return '';
	if (href.startsWith('//')) return 'https:' + href;
	if (href.startsWith('/')) return 'https://t.me' + href;
	if (href.startsWith('?')) return (base || '') + href;
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
// - 标题带媒体前缀 emoji：↩️ 回复 / 🎬 视频 / 🖼 图片，取正文第一行
// - 描述保留 <a>/<b>/<blockquote>/<br> 与 tg-emoji 自定义表情
// - 回复渲染为 <div class="rsshub-quote"><blockquote><p><a href><b>作者</b>:</a></p><p>引用</p></blockquote></div>
// - 图片/视频以 <img width height referrerpolicy> / <video> 形式追加在描述末尾
// - pubDate 为 RFC822 (toUTCString)
export const parseChannelPage = async (html, username) => {
	let title = '';
	let description = '';
	let texts = []; // 每条消息的 description html（按页面 DOM 顺序，最新在前）
	let dates = [];
	let links = [];
	let metas = []; // 每条消息 { photo, video, reply, replyAuthor, media[], pendingPhoto }

	let pushText = (t) => {
		if (texts.length) texts[texts.length - 1] += t;
	};
	let lastMeta = () => (metas.length ? metas[metas.length - 1] : null);
	let curLink = () => (links.length ? links[links.length - 1] : '');
	// 链接：echo t.me 原有的 target/rel/onclick 属性（外链才有），与 RSSHub 行为一致
	const linkAttrs = (el) =>
		['target', 'rel', 'onclick']
			.map((a) => {
				let v = el.getAttribute(a);
				return v === null ? '' : ` ${a}="${v}"`;
			})
			.join('');

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
			element(element) {
				texts.push('');
				metas.push({ photo: false, video: false, reply: false, replyAuthor: false, media: [], pendingPhoto: null });
				// 媒体统一追加在描述末尾（与 RSSHub 一致）
				element.onEndTag(() => {
					let meta = lastMeta();
					if (meta && meta.media.length) pushText(meta.media.join(''));
				});
			},
		})
		// 图片：photo_wrap(<a style="width:800px[;height:270px];background-image:url(...)">)
		// 单图的高度由内层 .tgme_widget_message_photo 的 padding-top 百分比计算，相册图直接带 height
		.on('.tgme_widget_message_bubble .tgme_widget_message_photo_wrap', {
			element(element) {
				let meta = lastMeta();
				if (!meta) return;
				meta.photo = true;
				let style = element.getAttribute('style') || '';
				let url = (style.match(/background-image:url\('([^']+)'\)/) || [])[1];
				let width = (style.match(/width:(\d+(?:\.\d+)?)px/) || [])[1];
				let height = (style.match(/height:(\d+(?:\.\d+)?)px/) || [])[1];
				if (url)
					meta.pendingPhoto = {
						url,
						width: width ? parseFloat(width) : null,
						height: height ? parseFloat(height) : null,
					};
			},
		})
		.on('.tgme_widget_message_bubble .tgme_widget_message_photo_wrap .tgme_widget_message_photo', {
			element(element) {
				let meta = lastMeta();
				if (!meta || !meta.pendingPhoto) return;
				let p = meta.pendingPhoto;
				if (p.height === null) {
					let pct = ((element.getAttribute('style') || '').match(/padding-top:([\d.]+)%/) || [])[1];
					if (pct && p.width !== null) p.height = p.width * (parseFloat(pct) / 100);
				}
				if (p.height !== null) p.height = parseFloat(p.height.toFixed(2));
				let dims = p.width !== null ? ` width="${p.width}"` + (p.height !== null ? ` height="${p.height}"` : '') : '';
				meta.media.push(`<img src="${p.url}"${dims} referrerpolicy="no-referrer">`);
				meta.pendingPhoto = null;
			},
		})
		// 视频：<video src="...mp4?token=..."> 直接给出可播放地址
		.on('.tgme_widget_message_bubble .tgme_widget_message_video_wrap', {
			element() {
				let meta = lastMeta();
				if (meta) meta.video = true;
			},
		})
		// 视频缩略图作为 poster（RSSHub 同样取自这里的 background-image）
		.on('.tgme_widget_message_bubble .tgme_widget_message_video_thumb', {
			element(element) {
				let meta = lastMeta();
				if (!meta) return;
				let m = (element.getAttribute('style') || '').match(/background-image:url\('([^']+)'\)/);
				if (m) meta.pendingPoster = m[1];
			},
		})
		.on('.tgme_widget_message_bubble .tgme_widget_message_video_wrap video', {
			element(element) {
				let meta = lastMeta();
				if (!meta) return;
				let src = element.getAttribute('src');
				if (src)
					meta.media.push(
						`<video src="${absUrl(src)}" controls="controls"${meta.pendingPoster ? ` poster="${meta.pendingPoster}"` : ''} style="width: 100%"></video>`,
					);
			},
		})
		// 回复块：<div class="rsshub-quote"><blockquote><p><a href="被回复消息"><b>
		// 作者名闭合时补 </b>:</a></p><p>，回复 a 闭合时收尾 </p></blockquote></div>
		.on('.tgme_widget_message_bubble .tgme_widget_message_reply', {
			element(element) {
				let meta = lastMeta();
				if (!meta) return;
				meta.reply = true;
				pushText(`<div class="rsshub-quote"><blockquote> <p><a href="${absUrl(element.getAttribute('href'))}"${linkAttrs(element)}><b>`);
				element.onEndTag(() => {
					pushText(meta.replyAuthor ? '</p> </blockquote></div>' : '</b></a></p> </blockquote></div>');
				});
			},
		})
		// 回复的作者名，闭合时收尾进入引用正文
		.on('.tgme_widget_message_bubble .tgme_widget_message_reply .tgme_widget_message_author_name', {
			text(text) {
				pushText(text.text);
			},
			element(element) {
				element.onEndTag(() => {
					let meta = lastMeta();
					if (!meta || !meta.reply || meta.replyAuthor) return;
					meta.replyAuthor = true;
					pushText('</b>:</a></p> <p>');
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
				pushText(`<a href="${absUrl(element.getAttribute('href'), curLink())}"${linkAttrs(element)}>`);
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
				// t.me 的可展开引用带 expandable 属性，与 RSSHub 一致地保留
				pushText(element.getAttribute('expandable') === null ? '<blockquote>' : '<blockquote expandable="">');
				element.onEndTag(() => pushText('</blockquote>'));
			},
		})
		.on('.tgme_widget_message_bubble .tgme_widget_message_text blockquote > b', {
			element(element) {
				pushText('<b>');
				element.onEndTag(() => pushText('</b>'));
			},
		})
		// 自定义表情保留 tg-emoji / span.emoji 包装，普通 <i>（如 via）原样保留
		.on('.tgme_widget_message_bubble .tgme_widget_message_text tg-emoji', {
			element(element) {
				pushText(`<tg-emoji emoji-id="${element.getAttribute('emoji-id')}">`);
				element.onEndTag(() => pushText('</tg-emoji>'));
			},
		})
		.on('.tgme_widget_message_bubble .tgme_widget_message_text i', {
			element(element) {
				let cls = element.getAttribute('class') || '';
				if (cls.includes('emoji')) {
					pushText('<span class="emoji">');
					element.onEndTag(() => pushText('</span>'));
				} else {
					pushText('<i>');
					element.onEndTag(() => pushText('</i>'));
				}
			},
		})
		.transform(new Response(html));
	await stream.text();

	// 标题取正文第一行纯文本（与 RSSHub 一致，回复块不参与标题）
	const stripReplyPrefix = (s) => {
		let m = s.match(/^<div class="rsshub-quote"><blockquote><p><a href="[^"]*"><b>[\s\S]*?<\/p><blockquote>[\s\S]*?<\/blockquote><\/div>/);
		if (!m) m = s.match(/^<div class="rsshub-quote"><blockquote>[\s\S]*?<\/blockquote><\/div>/);
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
			// \u00A0 回写为 &nbsp; 实体，与 RSSHub 输出保持一致
			description: decodeEntities(html).replace(/\u00A0/g, '&nbsp;'),
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
