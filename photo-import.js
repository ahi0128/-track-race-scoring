"use strict";

// Infer columns from the repeated bib positions instead of assuming that every
// photographed page uses the same margins. Manual boundaries remain optional.
function photoWords(tsv) {
  return tsv.split(/\r?\n/).slice(1).map(line => {
    const c = line.split("\t");
    return { level: Number(c[0]), x: Number(c[6]), y: Number(c[7]),
      w: Number(c[8]), h: Number(c[9]), text: c.slice(11).join("\t").trim() };
  }).filter(w => w.level === 5 && w.text && w.w > 0 && w.h > 0);
}
function photoMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}
function photoJoin(words) {
  return [...words].sort((a, b) => a.x - b.x).map(w => w.text).join(" ")
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1");
}
function photoBibGroups(words, width) {
  const groups = [];
  for (const word of words.filter(w => /^\d{1,5}$/.test(w.text))) {
    let group = groups.find(g => Math.abs(photoMedian(g.map(w => w.x + w.w / 2)) - (word.x + word.w / 2)) < width * .025);
    if (!group) groups.push(group = []);
    group.push(word);
  }
  const score = group => new Set(group.map(w => Number(w.text))).size + group.filter(w => Number(w.text) > 40).length * .2;
  return groups.filter(g => g.length >= 2).sort((a, b) => score(b) - score(a) || a[0].x - b[0].x);
}
function photoRowsAtBibs(words, bibs) {
  const sorted = [...bibs].sort((a, b) => a.y - b.y);
  return sorted.map((bib, index) => {
    const center = bib.y + bib.h / 2;
    const gap = Math.min(...[sorted[index - 1], sorted[index + 1]].filter(Boolean)
      .map(w => Math.abs(w.y + w.h / 2 - center)));
    const tolerance = Math.min(Math.max(bib.h * 1.3, 12), gap * .46);
    return { bib, words: words.filter(w => Math.abs(w.y + w.h / 2 - center) <= tolerance).sort((a, b) => a.x - b.x) };
  });
}
function photoAutoRoster(tsv, width, international = false) {
  const words = photoWords(tsv);
  const bibs = photoBibGroups(words, width)[0] || [];
  const sourceRows = photoRowsAtBibs(words, bibs);
  const candidates = sourceRows.map(({ bib, words: row }) => {
    const right = row.filter(w => w.x >= bib.x + bib.w && !/\d{6,}/.test(w.text));
    let size = 0;
    let split = -1;
    for (let i = 0; i < right.length - 1; i++) {
      size += right[i].text.replace(/\s/g, "").length;
      const gap = right[i + 1].x - right[i].x - right[i].w;
      if (size >= 2 && gap > Math.max(width * .014, right[i].h * .85)) { split = i + 1; break; }
    }
    return { bib, right, split };
  });
  const teamX = photoMedian(candidates.filter(r => r.split > 0).map(r => r.right[r.split].x));
  const seen = new Set();
  return candidates.map(({ bib, right, split }) => {
    if (seen.has(Number(bib.text))) return null;
    seen.add(Number(bib.text));
    const boundary = split > 0 ? right[split].x : teamX || Infinity;
    const name = photoJoin(right.filter(w => w.x < boundary));
    const team = photoJoin(right.filter(w => w.x >= boundary));
    return [bib.text, name, international ? "" : team, international ? team : ""];
  }).filter(Boolean);
}
function photoRosterFromTsv(tsv, width, columns, international = false) {
  const anchors = [columns.bib, columns.name, columns.team];
  if (!anchors.every(Number.isFinite) || new Set(anchors).size !== 3 ||
      Math.min(...anchors) < 0 || !Number.isFinite(columns.end) || columns.end > 100 || columns.end <= Math.max(...anchors)) {
    throw new Error("欄位位置必須不同，且介於 0 與名單終點之間。");
  }
  const words = photoWords(tsv);
  function inColumn(word, start) {
    const end = Math.min(...anchors.filter(anchor => anchor > start), columns.end);
    const center = (word.x + word.w / 2) * 100 / width;
    return center >= start && center < end;
  }
  const bibs = words.filter(w => inColumn(w, columns.bib) && /^\d{1,5}$/.test(w.text));
  return photoRowsAtBibs(words, bibs).map(({bib, words: row}) => {
    const name = photoJoin(row.filter(w => inColumn(w, columns.name)));
    const team = photoJoin(row.filter(w => inColumn(w, columns.team)));
    return [bib.text, name, international ? "" : team, international ? team : ""];
  });
}
function photoRosterFromText(text, international = false) {
  const seen = new Set();
  return text.split(/\r?\n/).map(line => {
    const match = line.trim().match(/^(\d{1,5})\s+(.+)/);
    if (!match || seen.has(Number(match[1]))) return null;
    const fields = match[2].replace(/\b\d{9,14}\b.*$/, "").trim().split(/\t+|\s{2,}/);
    if (!fields[0] || !/[A-Za-z\u3400-\u9fff]/.test(fields[0])) return null;
    seen.add(Number(match[1]));
    return [match[1], fields[0], international ? "" : fields.slice(1).join(" "), international ? fields.slice(1).join(" ") : ""];
  }).filter(Boolean);
}

(() => {
  let source = null;
  let angle = 0;
  let worker = null;
  let generation = 0;
  let libraryPromise = null;
  const canvas = $("photoPreview");
  const status = text => { $("photoStatus").textContent = text; };
  function busy(value) {
    for (const id of ["takePhoto", "choosePhoto", "rotatePhoto", "recognizePhoto", "photoFormat", "photoImport", "photoAuto", "photoBibX", "photoNameX", "photoTeamX", "photoEndX"]) {
      $(id).disabled = value || (!source && ["rotatePhoto", "recognizePhoto"].includes(id));
    }
  }
  async function stop() {
    generation++;
    const current = worker;
    worker = null;
    if (current) await current.terminate().catch(() => {});
    busy(false);
  }
  function draw() {
    const swapped = angle % 180 !== 0;
    const width = swapped ? source.height : source.width;
    const height = swapped ? source.width : source.height;
    const scale = Math.min(2, 3000 / Math.max(width, height));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(angle * Math.PI / 180);
    context.drawImage(source, -source.width * scale / 2, -source.height * scale / 2,
      source.width * scale, source.height * scale);
    canvas.hidden = false;
  }
  function loadLibrary() {
    if (window.Tesseract) return Promise.resolve();
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timer = setTimeout(() => fail(), 45000);
      function fail() { clearTimeout(timer); script.remove(); libraryPromise = null; reject(new Error("無法下載辨識工具，請確認連線後重試。")); }
      script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js";
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = fail;
      document.head.append(script);
    });
    return libraryPromise;
  }
  function recognitionImage() {
    const image = document.createElement("canvas");
    image.width = canvas.width;
    image.height = canvas.height;
    const context = image.getContext("2d", { willReadFrequently: true });
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height);
    let low = 255, high = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
      const gray = Math.round(.299 * pixels.data[i] + .587 * pixels.data[i + 1] + .114 * pixels.data[i + 2]);
      pixels.data[i] = gray;
      low = Math.min(low, gray);
      high = Math.max(high, gray);
    }
    for (let i = 0; i < pixels.data.length; i += 4) {
      const gray = (pixels.data[i] - low) * 255 / Math.max(1, high - low);
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
    }
    context.putImageData(pixels, 0, 0);
    return image;
  }
  async function chooseFile(event) {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    await stop();
    const token = generation;
    status("讀取照片…");
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (token !== generation) return;
      source = image;
      angle = 0;
      draw();
      $("photoRoster").value = "";
      $("photoRaw").value = "";
      $("photoChecked").checked = false;
      status("照片已載入。請確定名單文字清楚、方向正確，再開始辨識。");
    } catch { status("無法讀取此照片。請使用 JPG、PNG，或直接重新拍照。"); }
    finally { URL.revokeObjectURL(url); busy(false); }
  }
  $("photoOpen").onclick = () => $("photoDialog").showModal();
  $("photoClose").onclick = () => $("photoDialog").close();
  $("photoDialog").addEventListener("close", () => { stop(); status(""); });
  $("takePhoto").onclick = () => $("cameraFile").click();
  $("choosePhoto").onclick = () => $("photoFile").click();
  $("cameraFile").onchange = $("photoFile").onchange = chooseFile;
  $("rotatePhoto").onclick = () => { angle = (angle + 90) % 360; draw(); $("photoChecked").checked = false; };
  $("photoRoster").oninput = () => { $("photoChecked").checked = false; };
  for (const id of ["photoBibX", "photoNameX", "photoTeamX", "photoEndX"]) {
    $(id).oninput = () => { $("photoAuto").checked = false; };
  }
  $("photoFormat").onchange = () => {
    const international = $("photoFormat").value === "international";
    ["photoBibX", "photoNameX", "photoTeamX", "photoEndX"].forEach((id, index) => {
      $(id).value = (international ? [5, 15, 70, 95] : [13, 22, 38, 59])[index];
    });
    $("photoTeamLabel").firstChild.textContent = international ? "國家起點 %" : "隊伍起點 %";
    $("photoChecked").checked = false;
  };
  $("recognizePhoto").onclick = async () => {
    if (!source) return;
    await stop();
    const token = generation;
    let timeout;
    let created = null;
    busy(true);
    $("photoChecked").checked = false;
    status("載入辨識工具與語言資料，首次可能需要較久…");
    try {
      const international = $("photoFormat").value === "international";
      const columns = { bib: Number($("photoBibX").value), name: Number($("photoNameX").value),
        team: Number($("photoTeamX").value), end: Number($("photoEndX").value) };
      const automatic = $("photoAuto").checked;
      if (!automatic) photoRosterFromTsv("", canvas.width, columns, international);
      const operation = (async () => {
        await loadLibrary();
        if (token !== generation) return;
        created = await Tesseract.createWorker(international ? "eng" : "chi_tra", 1, {
          logger: info => { if (token === generation) status(info.status === "recognizing text"
            ? "辨識中 " + Math.round(info.progress * 100) + "%" : "載入語言與辨識工具…"); }
        });
        if (token !== generation) { await created.terminate(); return; }
        worker = created;
        await worker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
        return worker.recognize(recognitionImage(), {}, { text: true, tsv: true });
      })();
      const result = await Promise.race([operation, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("辨識逾時，請確認連線並用較清晰的照片重試。")), 150000);
      })]);
      if (token !== generation || !result) return;
      $("photoRaw").value = result.data.text || "";
      let rows = automatic ? photoAutoRoster(result.data.tsv || "", canvas.width, international)
        : photoRosterFromTsv(result.data.tsv || "", canvas.width, columns, international);
      if (!rows.length) rows = photoRosterFromText(result.data.text || "", international);
      $("photoRoster").value = rows.map(row => row.join("\t")).join("\n");
      $("photoRawDetails").open = !rows.length;
      status(rows.length ? "擷取到 " + rows.length + " 列候選名單，請核對人數、背號、姓名與隊伍；空白和誤字需修正。"
        : "未能組成名單，已保留辨識原文。請確認照片文字清楚；也可取消自動判斷，手動調整欄位後重試。");
    } catch (error) {
      if (token === generation) status("辨識未完成：" + error.message);
    } finally {
      clearTimeout(timeout);
      if (token === generation) await stop();
    }
  };
  $("photoImport").onclick = () => {
    try {
      if (!$("photoChecked").checked) throw new Error("請先對照原圖核對，再勾選核對完成。");
      const roster = parseRosterRows($("photoRoster").value.split(/\r?\n/).filter(row => row.trim()).map(row => row.split("\t")));
      if (!roster.length || roster.length > 40) throw new Error("請確認名單包含 1–40 位選手。");
      fillRoster(roster);
      $("setupError").textContent = "已匯入 " + roster.length + " 位選手，請確認賽事設定後開始。";
      $("photoDialog").close();
    } catch (error) { status(error.message); }
  };
})();
