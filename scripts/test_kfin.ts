import { refreshKfintechIpoList } from '../src/services/kfintech.service.js';

(async function(){
  try {
    const list = await refreshKfintechIpoList();
    console.log('TEST_KFIN: got', list.length);
    console.log(list.slice(0,10));
  } catch (e) {
    console.error('TEST_KFIN error', e);
  }
})();
