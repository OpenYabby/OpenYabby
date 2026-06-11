
    const fs = require('fs');
    const hitFile = 'hits.txt';
    let hits = fs.existsSync(hitFile) ? parseInt(fs.readFileSync(hitFile)) : 0;
    hits++;
    fs.writeFileSync(hitFile, hits.toString());
    if (hits > 1) {
      console.error("429 Too Many Requests");
      process.exit(1);
    }
    console.log("Success");
  