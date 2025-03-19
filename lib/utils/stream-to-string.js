'use strict';

module.exports = {
	streamToString: async stream => {
		return new Promise((resolve, reject) => {
			let data = '';
			// eslint-disable-next-line no-return-assign
			stream.on('data', chunk => data += chunk);
			stream.on('end', () => resolve(data));
			stream.on('error', reject);
		});
	}
};
