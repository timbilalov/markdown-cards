<script lang="ts">
	import 'bulma/css/bulma.min.css';
	import '@fortawesome/fontawesome-free/css/all.min.css';
	import '@fortawesome/fontawesome-free/css/v4-shims.min.css';
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { app } from '$lib/stores/appFacade';
	import { isAuthenticated } from '$lib/stores/cloudStore';
	import { pageTitle } from '$lib/stores/titleStore';
	import Header from '$lib/components/Header.svelte';

	let { children } = $props();
	let initialization = $state<'loading' | 'ready' | 'failed'>('loading');
	let initializationError = $state<string | null>(null);
	let mounted = false;
	let stop: (() => void) | undefined;
	async function initialize() {
		initialization = 'loading'; initializationError = null;
		try { await app.initialize(); if (mounted) initialization = 'ready'; }
		catch (error) {
			if (mounted) {
				initialization = 'failed';
				initializationError = error instanceof Error ? error.message : 'Локальное хранилище недоступно';
			}
		}
	}
	function retryInitialization() {
		stop?.(); stop = app.start(); void initialize();
	}

	onMount(() => {
		mounted = true; stop = app.start(); void initialize();
		return () => { mounted = false; stop?.(); };
	});

	$effect(() => {
		if (initialization !== 'loading' && !$isAuthenticated && page.url.pathname !== '/login') {
			void goto('/login', { replaceState: true });
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>{$pageTitle}</title>
</svelte:head>

<style>
	:global(.app-root) {
		display: contents;
	}

	.wrapper {
		display: flex;
		flex-direction: column;
	}
</style>

<div class="wrapper">
	<Header />
	{#if initializationError && page.url.pathname !== '/login'}
		<div role="alert">
			<p>Не удалось открыть локальное хранилище: {initializationError}</p>
			<button data-retry-initialization onclick={retryInitialization}>Повторить загрузку</button>
		</div>
	{:else if page.url.pathname === '/login' || initialization === 'ready' && $isAuthenticated}
		{@render children?.()}
	{:else if initialization === 'loading'}
		<p role="status">Загрузка приложения…</p>
	{/if}
</div>
