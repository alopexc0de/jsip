function main() {
	const ws = new WebSocket('wss://tun.doridian.net');
	ws.binaryType = 'arraybuffer';
	window.ws = ws;

	let ourIp, serverIp;

	ws.onmessage = function(msg) {
		const data = msg.data;
		if (typeof data === 'string') {
			const spl = data.split('|');
			ourIp = IPAddr.fromString(spl[1]);
			serverIp = IPAddr.fromString(spl[0]);
			console.log(`Our IP: ${ourIp}`);
			console.log(`Server IP: ${serverIp}`);
		} else {
			const ipHdr = IPHdr.fromPacket(data);
			switch (ipHdr.protocol) {
				case 1: // ICMP
					const icmpHdr = ICMPHdr.fromPacket(data, ipHdr.getContentOffset(), ipHdr.getContentLength());
					console.log(icmpHdr);
			}
		}
	}
}
