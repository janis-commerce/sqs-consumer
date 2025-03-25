'use strict';

module.exports = {
	streamToString: async stream => {
		let data = '';
		for await (const chunk of stream)
			data += chunk;

		return data;
	}
};
