import axios from 'axios';

const KEY = '3a07bb23-9f8b-4c1c-b7ff-bb316b3765f2';

// Check state-based search
const r = await axios.get('https://ridb.recreation.gov/api/v1/facilities', {
  params: { state: 'CA', activity: 9, limit: 10, offset: 0, full: false },
  headers: { apikey: KEY },
});

console.log('CA camping facilities total:', r.data.METADATA.RESULTS.TOTAL_COUNT);
console.log('\nSample:');
for (const f of r.data.RECDATA.slice(0, 10)) {
  console.log(`  ${f.FacilityID} | type="${f.FacilityTypeDescription}" | reservable=${f.Reservable} | "${f.FacilityName}" | lat=${f.FacilityLatitude}`);
}
