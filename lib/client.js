window.__ModuleLoader__.load({
	id: "dsh-routerai-prices",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const h = react.createElement;

		/** Host route that resolves the current price of each watched provider. */
		const ROUTE = "/routerai-prices";
		const ROUTE_INTERVAL = "/routerai-prices/interval";
		const CSS_ID = "dsh-routerai-prices:stack";

		/**
		 * `sidebar.footer.action` is a `list` slot and its host container is a
		 * plain `display:flex` row, so every block registered there lands beside
		 * its neighbour. No vertical slot exists in the sidebar footer, so this
		 * single rule turns that one container into a column.
		 *
		 * The selector is bounded on purpose: it reaches the container that
		 * directly (or through one wrapper) holds our marker and never climbs
		 * higher, so the outer shell layout is untouched.
		 */
		const CSS = ":has(> [data-routerai-prices]), :has(> * > [data-routerai-prices]){flex-direction:column}";

		/**
		 * Fallback poll interval. The real one is a setting (1-60 minutes) read from
		 * the Host with every answer, so a change applies without a reload. It paces
		 * ONLY the price poll; the active-model highlight comes from the live
		 * `useSessions` subscription and switches instantly.
		 */
		const DEFAULT_INTERVAL_MS = 300000;

		const COLOR_MUTED = "var(--dsw-alias-label-tertiary, inherit)";
		const COLOR_GROUP = "var(--dsw-alias-label-secondary, inherit)";
		const COLOR_TEXT = "var(--dsw-alias-label-primary, inherit)";
		const BORDER = "var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))";
		/** Fill of the row whose model the active session is using. */
		const HIGHLIGHT = "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))";

		/** Rubles per million tokens. The API quotes a per-token rate. */
		function perMillion(value) {
			if (typeof value !== "number" || !isFinite(value)) return "—";
			return (value * 1000000).toFixed(2);
		}

		/**
		 * Provider and model of the session shown in the centre column. The frame
		 * marks that session by a positive `retainedBy.mainView` count, the same
		 * signal the shell's own document title reads; a session merely open in the
		 * background carries zero there.
		 *
		 * Both facts are read from the single root hook `useSessions`: the active id
		 * from `byId`, and the chosen model from the session projection
		 * `projectionsBySession[id].values.modelSelection`, whose `next` is the
		 * chosen model and `lastUsed` the one actually running, so a pending switch
		 * still resolves to something meaningful.
		 *
		 * The per-session `useSession` hook is deliberately not used: the sidebar
		 * footer is a root-scope slot, where only `useSessions` is supplied. Any
		 * missing piece returns null: an unknown active model must leave the table
		 * unhighlighted rather than guess at a row.
		 */
		function activeSelection(useSessions) {
			return useSessions((state) => {
				if (!state || !state.byId) return null;
				let held = null;
				for (const id of Object.keys(state.byId)) {
					const entry = state.byId[id];
					if (entry && (entry.retainedBy && entry.retainedBy.mainView || 0) > 0) {
						held = id;
						break;
					}
				}
				if (held === null) return null;
				const projection = state.projectionsBySession
					&& state.projectionsBySession[held]
					&& state.projectionsBySession[held].values
					&& state.projectionsBySession[held].values.modelSelection;
				if (!projection) return null;
				return projection.next || projection.lastUsed || null;
			});
		}

		/**
		 * The configured id the active selection is running, matched against the
		 * `modelId` the host reports for every row.
		 *
		 * Both sides carry the SAME string: the host echoes the configured id
		 * verbatim, and the session records the very id the UI selected. A pinned
		 * model (`...@provider=relace&allow_fallbacks=false`) and an unpinned one
		 * (`openai/gpt-6-luna-pro`) are both ordinary, separately configurable
		 * entries, so each keeps its own row and matches exactly.
		 *
		 * An exact hit decides. Only when the tails differ does a pinned comparison
		 * follow — same pin, flags after it ignored — which still names one row, so
		 * it is a match and not a guess. Anything else highlights nothing: naming a
		 * model the session may not be running would be worse than staying silent.
		 */
		function activeModelId(selection, rows) {
			if (selection === null || typeof selection.model !== "string") return null;
			const want = selection.model;
			const wantPin = pinOf(want);
			let loose = null;
			for (const row of rows) {
				const id = typeof row.modelId === "string" ? row.modelId : "";
				if (id === "") continue;
				if (id === want) return id;
				const pin = pinOf(id);
				if (pin !== null && wantPin !== null && pin === wantPin && id.slice(0, id.indexOf("@provider=")) === want.slice(0, want.indexOf("@provider="))) {
					if (loose === null) loose = id;
				}
			}
			return loose;
		}

		/** The `@provider=` pin of a configured id, or null when it carries none. */
		function pinOf(id) {
			const at = id.indexOf("@provider=");
			return at < 0 ? null : id.slice(at + 10).split("&")[0];
		}

		function Prices(props) {
			const wide = props.wide !== false;
			/**
			 * Slot-supplied hook. A host without it (a slot rendered outside the
			 * frame) leaves it undefined, and the table simply stays unhighlighted.
			 */
			const useSessions = props.useSessions;
			const canHighlight = typeof useSessions === "function";
			const [state, setState] = react.useState({ status: "loading" });
			react.useEffect(() => {
				let alive = true;
				let timer = null;
				/** A failed poll keeps the last good rows instead of blanking the block. */
				const load = () => {
					fetch(ROUTE, { cache: "no-store" }).then((response) => response.json()).then((payload) => {
						if (!alive || !payload) return;
						/** Follow the interval the Host reports; a change then needs no reload. */
						applyInterval(payload.intervalMs);
						if (payload.ok !== true || !Array.isArray(payload.rows)) {
							setState({ status: "error", reason: payload && payload.error ? payload.error : "unreachable", at: Date.now() });
							return;
						}
						setState({
							status: "ok",
							rows: payload.rows,
							at: payload.at
						});
					}).catch(() => {});
				};
				/** Effective interval, replaced whenever the Host reports a new one. */
				let interval = DEFAULT_INTERVAL_MS;
				/**
				 * Adopt the interval the Host reports. A change restarts the timer so the
				 * next poll already uses it; an absent or too-small value is ignored.
				 */
				const applyInterval = (next) => {
					if (typeof next !== "number" || !isFinite(next) || next < 60000) return;
					if (next === interval) return;
					interval = next;
					if (timer !== null) {
						clearInterval(timer);
						timer = setInterval(load, interval);
					}
				};
				const start = () => {
					if (timer === null) timer = setInterval(load, interval);
				};
				const stop = () => {
					if (timer !== null) {
						clearInterval(timer);
						timer = null;
					}
				};
				/** No polling while the window is hidden; one refresh on return. */
				const onVisibility = () => {
					if (document.hidden) stop();
					else {
						load();
						start();
					}
				};
				load();
				if (!document.hidden) start();
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					alive = false;
					stop();
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, []);
			/** Human text for the Host refusal or an empty table. */
			const emptyText = () => {
				if (state.status === "loading") return "…";
				if (state.status === "error") {
					if (typeof state.reason === "string" && state.reason.indexOf("http-") === 0) return "RouterAI ответил " + state.reason.slice(5);
					return "RouterAI недоступен";
				}
				return "нет моделей";
			};
			const ok = state.status === "ok";
			const rows = ok ? state.rows : [];
			/**
			 * The model the centre column's session runs, resolved to the configured
			 * id this table lists. `useSessions` is called unconditionally so the hook
			 * order stays stable; a slot that supplies none simply leaves the table
			 * unhighlighted.
			 */
			const selection = canHighlight
				? activeSelection(useSessions)
				: null;
			const activeId = selection === null ? null : activeModelId(selection, rows);
			const cell = {
				fontSize: "11px",
				lineHeight: "15px",
				fontVariantNumeric: "tabular-nums",
				whiteSpace: "nowrap"
			};
			/** 1px inside the cell keeps the text off the group divider; the row gap is the table's. */
			const line = Object.assign({}, cell, { padding: "1px 0" });
			const head = Object.assign({}, cell, {
				fontSize: "8px",
				letterSpacing: "0.1em",
				textTransform: "uppercase",
				fontWeight: 500,
				padding: "0 0 5px 0",
				borderBottom: "1px solid " + BORDER,
				color: COLOR_MUTED
			});
			const groupCell = Object.assign({}, cell, {
				color: COLOR_GROUP,
				fontWeight: 500,
				fontSize: "10px",
				textTransform: "uppercase", letterSpacing: "0.1em",
				padding: "0 0 0 0",
				overflow: "hidden",
				textOverflow: "ellipsis"
			});
			/** Vertical padding matches the label cell so middle alignment lines both up. */
			const num = Object.assign({}, cell, {
				textAlign: "right",
				paddingLeft: "5px",
				paddingRight: "5px",
				paddingTop: "1px",
				paddingBottom: "1px",
				color: COLOR_TEXT
			});
			/**
			 * Grouped by catalog name rather than by adjacency: a variant placed
			 * elsewhere in the config list still belongs under its own heading.
			 */
			const body = [];
			if (ok && rows.length > 0) {
				const order = [];
				const grouped = new Map();
				rows.forEach((row) => {
					const key = row.group || "";
					if (!grouped.has(key)) {
						grouped.set(key, []);
						order.push(key);
					}
					grouped.get(key).push(row);
				});
				order.forEach((key, groupIndex) => {
					const items = grouped.get(key);
					/**
					 * A vendor divider is the next heading's top border, drawn on its top edge.
					 * Padding inside that cell would push the heading down instead of giving
					 * the line room above it, so the breath between vendors is a spacer row.
					 */
					if (groupIndex > 0) {
						body.push(h("tr", {
							key: "gap-" + String(groupIndex)
						}, h("td", {
							colSpan: 4,
							style: { height: "4px", padding: "0" }
						})));
					}
					body.push(h("tr", {
						key: "group-" + String(groupIndex)
					}, h("td", {
						colSpan: 4,
						style: Object.assign({}, groupCell, {
							/**
							 * The divider is the cell's top border, so it sits ON the top edge: the
							 * space above it cannot come from padding and is supplied by the spacer
							 * row pushed before the group. The padding below only keeps the line off
							 * its own heading.
							 */
							paddingTop: "8px",
							paddingBottom: "2px",
							borderTop: groupIndex === 0 ? "none" : "1px solid " + BORDER
						})
					}, key)));
					items.forEach((row, i) => {
						/** The row the centre column's session is running, filled on every cell so the band spans the table. */
						const live = activeId !== null && row.modelId === activeId;
						const fill = live ? { background: HIGHLIGHT } : null;
						body.push(h("tr", {
							key: String(groupIndex) + ":" + String(i) + ":" + row.label
						}, h("td", {
							style: Object.assign({}, line, {
								color: live ? COLOR_TEXT : COLOR_MUTED,
								paddingLeft: "14px",
								paddingRight: "5px",
								overflow: "hidden",
								textOverflow: "ellipsis"
							}, fill)
						}, "•\u00a0" + row.label), h("td", {
							style: fill ? Object.assign({}, num, fill) : num
						}, row.ok && row.price ? perMillion(row.price.prompt) : "—"), h("td", {
							style: fill ? Object.assign({}, num, fill) : num
						}, row.ok && row.price ? perMillion(row.price.completion) : "—"), h("td", {
							style: Object.assign({}, num, { color: COLOR_MUTED }, fill)
						}, row.ok && row.price ? perMillion(row.price.input_cache_read) : "—")));
					});
				});
			} else {
				body.push(h("tr", {
					key: "empty"
				}, h("td", {
					style: Object.assign({}, cell, { color: COLOR_MUTED })
				}, emptyText()), h("td", {
					style: num
				}, ""), h("td", {
					style: num
				}, ""), h("td", {
					style: num
				}, "")));
			}
			return h("div", {
				"data-routerai-prices": "",
				title: ok ? "Цены обновлены " + new Date(state.at).toLocaleTimeString("ru-RU", {
					hour: "2-digit",
					minute: "2-digit"
				}) : "RouterAI · цены",
				style: {
					display: wide ? "block" : "none",
					boxSizing: "border-box",
					width: "100%",
					minWidth: 0,
					margin: "0 auto 20px auto",
					padding: "0 10px",
					userSelect: "none"
				}
			}, h("table", {
				style: {
					width: "100%",
					/** Separated borders: a cell margin is ignored while borders collapse. */
					borderCollapse: "separate",
					borderSpacing: "0 3px"
				}
			}, h("thead", null, h("tr", null, h("th", {
				style: Object.assign({}, head, { textAlign: "left" })
			}, "Модель"), h("th", {
				style: Object.assign({}, head, { textAlign: "right", paddingLeft: "5px", paddingRight: "5px" })
			}, "вход"), h("th", {
				style: Object.assign({}, head, { textAlign: "right", paddingLeft: "5px", paddingRight: "5px" })
			}, "выход"), h("th", {
				style: Object.assign({}, head, { textAlign: "right", paddingLeft: "5px", paddingRight: "5px" })
			}, "кэш"))), h("tbody", null, body)));
		}

		/**
		 * The refresh interval, in minutes. Served as a section on this bundle page
		 * in Plugins, so the setting lives with the plugin it belongs to.
		 */
		function IntervalForm() {
			const [state, setState] = react.useState({ status: "loading" });
			const [draft, setDraft] = react.useState("");

			react.useEffect(() => {
				let alive = true;
				fetch(ROUTE_INTERVAL, { cache: "no-store" })
					.then((response) => response.json())
					.then((payload) => {
						if (!alive || !payload || payload.ok !== true) return;
						setState({ status: "ok", value: payload.intervalMinutes, writable: payload.writable !== false, min: payload.min, max: payload.max });
						setDraft(String(payload.intervalMinutes));
					})
					.catch(() => {
						if (alive) setState({ status: "error" });
					});
				return () => {
					alive = false;
				};
			}, []);

			const busy = state.status === "saving";
			/**
			 * A blank field is not zero: Number("") is 0, which would pass a plain
			 * finite check and let the Host clamp a value the user never typed.
			 */
			const save = () => {
				const trimmed = draft.trim();
				const next = trimmed.length === 0 ? NaN : Number(trimmed);
				const min = state.min === undefined ? 1 : state.min;
				const max = state.max === undefined ? 60 : state.max;
				if (!isFinite(next) || next < min || next > max) {
					setState(Object.assign({}, state, { error: "number" }));
					return;
				}
				setState(Object.assign({}, state, { status: "saving", error: undefined }));
				fetch(ROUTE_INTERVAL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ intervalMinutes: next })
				})
					.then((response) => response.json())
					.then((payload) => {
						if (!payload || payload.ok !== true) {
							setState(Object.assign({}, state, { status: "ok", error: "failed" }));
							return;
						}
						setState({ status: "ok", value: payload.intervalMinutes, writable: true, min: state.min, max: state.max, saved: true });
						setDraft(String(payload.intervalMinutes));
					})
					.catch(() => setState(Object.assign({}, state, { status: "ok", error: "failed" })));
			};

			const disabled = state.status === "loading" || state.status === "error" || state.writable === false || busy;
			const min = state.min === undefined ? 1 : state.min;
			const max = state.max === undefined ? 60 : state.max;
			return h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", padding: "2px 0" } }, [
				h("div", { key: "label", style: { fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary, inherit)" } }, "RouterAI · интервал обновления цен"),
				h("div", { key: "row", style: { display: "flex", alignItems: "center", gap: "8px" } }, [
					h("input", { key: "input", type: "number", value: draft, min: min, max: max, disabled: disabled, onChange: (event) => setDraft(event.target.value), style: { width: "90px", padding: "4px 6px", font: "inherit", fontSize: "13px", color: "var(--dsw-alias-label-primary, inherit)", background: "var(--dsw-alias-bg-layer-1, transparent)", border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))", borderRadius: "4px" } }),
					h("span", { key: "unit", style: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary, inherit)" } }, "мин"),
					h("button", { key: "save", type: "button", disabled: disabled, onClick: save, style: { padding: "4px 10px", font: "inherit", fontSize: "13px", cursor: disabled ? "default" : "pointer", color: "var(--dsw-alias-label-primary, inherit)", background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))", border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))", borderRadius: "4px" } }, busy ? "Сохранение…" : "Сохранить")
				]),
				state.error === "number" ? h("div", { key: "bad", style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #e5484d)" } }, "Введите целое число минут от " + min + " до " + max + ".") : null,
				state.error === "failed" ? h("div", { key: "fail", style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #e5484d)" } }, "Не удалось сохранить значение — оно осталось прежним.") : null,
				state.writable === false ? h("div", { key: "ro", style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, inherit)" } }, "В этом развёртывании настройка только для чтения.") : null,
				h("div", { key: "hint", style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, inherit)" } }, "Как часто панель запрашивает цены, от " + min + " до " + max + " минут.")
			]);
		}

		/** Only the slot service: no locale namespace, no other dependency. */
		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-routerai-prices";
				tag.dataset.pluginCss = CSS_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "routerai-prices: stack style");
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "routerai-prices",
				order: 90
			}, Prices));
			/**
			 * The interval control, on this bundle page in Plugins: between the
			 * description and the rows, where a plugin settings belong.
			 */
			ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: "dsh-routerai-prices"
			}, IntervalForm));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
