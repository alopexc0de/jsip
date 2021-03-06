'use strict';

const udpListeners = {
	7: (data, ipHdr, reply) => { // ECHO
		reply(data);
	},
};

function udpGotPacket(ipHdr, udpPkt) {
	const listener = udpListeners[udpPkt.dport];
	if (listener) {
		return listener(udpPkt.data, ipHdr, data => {
			const ip = ipHdr.makeReply();
			const udp = new UDPPkt();
			udp.sport = udpPkt.dport;
			udp.dport = udpPkt.sport;
			udp.data = data;
			return sendPacket(ip, udp);
		});
	}
}

function udpListenRandom(func) {
	let port = 0;
	do {
		port = 4097 + Math.floor(Math.random() * 61347);
	} while(udpListeners[port]);

	return udpListen(port, func);
}

function udpListen(port, func) {
	if (typeof port !== 'number' || port < 1 || port > 65535) {
		return false;
	}

	if  (udpListeners[port]) {
		return false;
	}

	udpListeners[port] = func;
	return true;
}

function udpCloseListener(port) {
	if (typeof port !== 'number' || port < 1 || port > 65535) {
		return false;
	}

	if (port === 7) {
		return false;
	}

	delete udpListeners[port];
	return true;
}
