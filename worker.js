'use strict';

let ourIp, serverIp, mtu, ws;

try {
	importScripts(
		'lib/util.js',
		'lib/bitfield.js',
		'lib/ip.js',
		'lib/icmp.js',
		'lib/udp.js',
		'lib/tcp.js',
		'lib/tcp_stack.js',
		'lib/udp_stack.js'
	);
} catch(e) { }

function sendPacket(ipHdr, payload) {
	const fullLength = payload.getFullLength();
	const hdrLen = ipHdr.getContentOffset();
	const mss = mtu - hdrLen;

	if (fullLength <= mss) {
		ipHdr.setContentLength(fullLength);

		const reply = new ArrayBuffer(ipHdr.getFullLength());

		let offset = 0;
		offset += ipHdr.toPacket(reply, offset, ipHdr);
		offset += payload.toPacket(reply, offset, ipHdr);

		ws.send(reply);
	} else if (ipHdr.df) {
		throw new Error('Needing to send packet too big for MTU/MSS, but DF set');
	} else {
		const pieceMax = Math.ceil(fullLength / mss) - 1;
		ipHdr.mf = true;

		const replyPacket = new ArrayBuffer(fullLength);
		payload.toPacket(replyPacket, 0, ipHdr);
		const r8 = new Uint8Array(replyPacket);

		let pktData = new ArrayBuffer(hdrLen + mss);
		let p8 = new Uint8Array(pktData);

		for (let i = 0; i <= pieceMax; i++) {
			const offset = mss * i;
			let pieceLen = mss;
			if (i === pieceMax) {
				ipHdr.mf = false;
				pieceLen = replyPacket.byteLength % mss;
				pktData = new ArrayBuffer(hdrLen + pieceLen);
				p8 = new Uint8Array(pktData);
			}

			ipHdr.frag_offset = offset >>> 3;
			ipHdr.setContentLength(pieceLen);

			ipHdr.toPacket(pktData, 0, ipHdr);
			for (let j = 0; j < pieceLen; j++) {
				p8[j + hdrLen] = r8[j + offset];
			}

			ws.send(pktData);
		}
	}
}

function handlePacket(ipHdr, data) {
	switch (ipHdr.protocol) {
		case PROTO_ICMP:
			const icmpPkt = ICMPPkt.fromPacket(data, 0, data.byteLength);
			switch (icmpPkt.type) {
				case 8: // PING / Echo Request
					const replyIp = ipHdr.makeReply();

					const replyICMP = new ICMPPkt();
					replyICMP.type = 0;
					replyICMP.code = 0;
					replyICMP.rest = icmpPkt.rest;
					replyICMP.data = icmpPkt.data;

					sendPacket(replyIp, replyICMP);
					break;
				default:
					console.log(`Unhandled ICMP type ${icmpPkt.type}`);
					break;
			}
			break;
		case PROTO_TCP: // TCP
			const tcpPkt = TCPPkt.fromPacket(data, 0, data.byteLength, ipHdr);
			tcpGotPacket(ipHdr, tcpPkt);
			break;
		case PROTO_UDP: // UDP
			const udpPkt = UDPPkt.fromPacket(data, 0, data.byteLength, ipHdr);
			udpGotPacket(ipHdr, udpPkt);
			break;
		default:
			console.log(`Unhandled IP protocol ${ipHdr.protocol}`);
			break;
	}
}

const fragmentCache = {};

function handleIP(buffer) {
	const ipHdr = IPHdr.fromPacket(buffer);

	if (!ipHdr.daddr.equals(ourIp)) {
		console.log(`Discarding packet not meant for us, but for ${ipHdr.daddr.toString()}`);
		return;
	}

	const isFrag = ipHdr.mf || ipHdr.frag_offset > 0;
	const pktData = buffer.slice(ipHdr.getContentOffset());

	if (!isFrag) {
		return handlePacket(ipHdr, pktData);
	}

	const pktId = ipHdr.id + (ipHdr.saddr.toInt() << 16);
	let curFrag = fragmentCache[pktId];
	if (!curFrag) {
		curFrag = {
			time: Date.now(),
		};
		fragmentCache[pktId] = curFrag;
	}

	const fragOffset = ipHdr.frag_offset << 3;
	curFrag[fragOffset] = {
		ipHdr,
		pktData,
	};
	if (!ipHdr.mf) {
		curFrag.last = fragOffset;
	}
	if (ipHdr.frag_offset === 0) {
		curFrag.validUntil = 0;
	}

	// Check if we got all fragments
	if (curFrag.validUntil !== undefined && curFrag.last !== undefined) {
		let curPiecePos = curFrag.validUntil;
		let curPiece = curFrag[curPiecePos];
		let gotAll = false;
		while (true) {
			curPiecePos += curPiece.pktData.byteLength;
			curPiece = curFrag[curPiecePos];
			if (!curPiece) {
				break;
			}
			if (!curPiece.ipHdr.mf) {
				gotAll = true;
				break;
			}
		}

		if (gotAll) {
			const fullData = new ArrayBuffer(curFrag[curFrag.last].pktData.byteLength + curFrag.last);
			const d8 = new Uint8Array(fullData);
			let curPiecePos = 0;
			let curPiece = curFrag[curPiecePos];
			while (true) {
				const p8 = new Uint8Array(curPiece.pktData);
				for (let i = 0; i < p8.length; i++) {
					d8[curPiecePos + i] = p8[i];
				}
				if (!curPiece.ipHdr.mf) {
					break;
				}
				curPiecePos += curPiece.pktData.byteLength;
				curPiece = curFrag[curPiecePos];
			}
			return handlePacket(ipHdr, fullData);
		}
	}
}

function timeoutFragments() {
	const cutoff = Date.now() - 30000;
	for (let id in fragmentCache) {
		const frag = fragmentCache[id];
		if (frag.time < cutoff) {
			delete fragmentCache[id];
		}
	}
}

function test() {
	console.log('XXX');
	const conn = tcpConnect(serverIp, 8000, (data, tcpConn) => {
		console.log('Data!', new Uint8Array(data));
	}, (res) => {
		console.log('Connection!', res);
		const s = 'GET / HTTP/1.0\r\n\r\n';
		const d = new ArrayBuffer(s.length);
		const d8 = new Uint8Array(d);
		for (let i = 0; i < s.length; i++) {
			d8[i] = s.charCodeAt(i);
		}
		conn.send(d);
	});
}

function main() {
	ws = new WebSocket('ws://127.0.0.1:9000');
	ws.binaryType = 'arraybuffer';

	ws.onmessage = function(msg) {
		const data = msg.data;
		if (typeof data === 'string') {
			const spl = data.split('|');
			ourIp = IPAddr.fromString(spl[1]);
			serverIp = IPAddr.fromString(spl[0]);
			mtu = parseInt(spl[2]);
			console.log(`Our IP: ${ourIp}`);
			console.log(`Server IP: ${serverIp}`);
			console.log(`Link-MTU: ${mtu}`);
			mtu -= 4;
			console.log(`TUN-MTU: ${mtu}`);

			//setTimeout(test, 5000);
		} else {
			handleIP(data);
		}
	}
}

//main();

setInterval(timeoutFragments, 1000);
