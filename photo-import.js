"use strict";

// Bounding boxes keep the long UCI number and the two start-position headings
// out of the rider fields. Every result still needs the user's review.
function photoRosterFromTsv(tsv, width, columns, international = false) {
  const anchors = [columns.bib, columns.name, columns.team];
  if (!anchors.every(Number.isFinite) || new Set(anchors).size !== 3 ||
      Math.min(...anchors) < 0 || columns.end > 100 || columns.end <= Math.max(...anchors)) {
    throw new Error("欄位位置必須不同，且介於 0 與名單終點之間。");
  }
  const words = tsv.split(/\r?\n/).slice(1).map(line => {
    const cells = line.split("\t");
    return { level: Number(cells[0]), x: Number(cells[6]), y: Number(cells[7]),
      w: Number(cells[8]), h: Number(cells[9]), text: cells.slice(11).join("\t").trim() };
  }).filter(word => word.level === 5 && word.text && word.w > 0);
  function inColumn(word, start) {
    const end = Math.min(...anchors.filter(anchor => anchor > start), columns.end);
    const center = (word.x + word.w / 2) * 100 / width;
    return center >= start && center < end;
  }
  const bibWords = words.filter(word => inColumn(word, columns.bib) && /^\d{1,5}$/.test(word.text));
  const sorted = [...bibWords].sort((a, b) => a.y - b.y);
  function join(tokens) {
    return tokens.sort((a, b) => a.x - b.x).map(word => word.text).join(" ")
      .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1");
  }
  return sorted.map((bib, index) => {
    const center = bib.y + bib.h / 2;
    const neighbors = [sorted[index - 1], sorted[index + 1]].filter(Boolean);
    const gap = Math.min(...neighbors.map(other => Math.abs(other.y + other.h / 2 - center)));
    const tolerance = Math.min(Math.max(bib.h, 12), gap * .45);
    const row = words.filter(word => Math.abs(word.y + word.h / 2 - center) <= tolerance);
    const name = join(row.filter(word => inColumn(word, columns.name)));
    const team = join(row.filter(word => inColumn(word, columns.team)));
    // A number without a name is usually part of a date, heading, or distance.
    if (!name || !/[A-Za-z\u3400-\u9fff]/.test(name)) return null;
    return [bib.text, name, international ? "" : team, international ? team : ""];
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
    for (const id of ["takePhoto", "choosePhoto", "rotatePhoto", "recognizePhoto", "photoFormat", "photoImport"]) {
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
    const scale = Math.min(2, 2400 / Math.max(width, height));
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
      photoRosterFromTsv("", canvas.width, columns, international);
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
        return worker.recognize(canvas, {}, { text: true, tsv: true });
      })();
      const result = await Promise.race([operation, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("辨識逾時，請確認連線並用較清晰的照片重試。")), 150000);
      })]);
      if (token !== generation || !result) return;
      const rows = photoRosterFromTsv(result.data.tsv || "", canvas.width, columns, international);
      $("photoRoster").value = rows.map(row => row.join("\t")).join("\n");
      status(rows.length ? "辨識到 " + rows.length + " 位。請逐列對照原圖；缺漏的選手可在下方補入。"
        : "未能分出選手欄位。請調整欄位位置後重試，或在下方貼上整理好的四欄名單。");
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
