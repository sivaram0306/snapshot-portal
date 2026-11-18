async function refreshDashboard() {

  try {

    toast("Refreshing...");

    const region =
      getRegion();


    const instanceResponse =
      await fetch(
        `/api/instances?region=${encodeURIComponent(region)}`
      );


    const instances =
      await instanceResponse.json();


    if (!instanceResponse.ok) {

      throw new Error(
        instances.message
      );

    }


    document.getElementById(
      "instanceCount"
    ).textContent =
      instances.length;


    const volumes =
      instances.reduce(
        (total, instance) =>
          total + instance.volumes.length,
        0
      );


    document.getElementById(
      "volumeCount"
    ).textContent =
      volumes;


    const snapshotResponse =
      await fetch(
        `/api/snapshots?region=${encodeURIComponent(region)}`
      );


    const snapshots =
      await snapshotResponse.json();


    if (!snapshotResponse.ok) {

      throw new Error(
        snapshots.message
      );

    }


    document.getElementById(
      "snapshotCount"
    ).textContent =
      snapshots.length;


    toast(
      "Dashboard updated."
    );


  } catch (error) {

    toast(
      error.message
    );

  }

}


document.addEventListener(
  "DOMContentLoaded",
  refreshDashboard
);
