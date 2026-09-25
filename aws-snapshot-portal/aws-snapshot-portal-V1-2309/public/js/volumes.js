let selectedVolume = null;


async function loadInstancesForDropdown() {

  try {

    const response =
      await fetch(
        `/api/instances?region=${encodeURIComponent(getRegion())}`
      );


    const instances =
      await response.json();


    if (!response.ok) {

      throw new Error(
        instances.message
      );

    }


    const select =
      document.getElementById(
        "instanceSelect"
      );


    instances.forEach(instance => {

      const option =
        document.createElement("option");


      option.value =
        instance.instanceId;


      option.textContent =
        `${instance.name} (${instance.instanceId})`;


      select.appendChild(
        option
      );

    });


    const params =
      new URLSearchParams(
        window.location.search
      );


    const requested =
      params.get(
        "instanceId"
      );


    if (requested) {

      select.value =
        requested;

      loadVolumes();

    }

  } catch (error) {

    toast(
      error.message
    );

  }

}


async function loadVolumes() {

  const instanceId =
    document.getElementById(
      "instanceSelect"
    ).value;


  if (!instanceId) {

    toast(
      "Select an instance."
    );

    return;

  }


  try {

    toast(
      "Loading volumes..."
    );


    const response =
      await fetch(
        `/api/volumes?region=${encodeURIComponent(getRegion())}&instanceId=${encodeURIComponent(instanceId)}`
      );


    const volumes =
      await response.json();


    if (!response.ok) {

      throw new Error(
        volumes.message
      );

    }


    renderVolumes(
      volumes
    );


  } catch (error) {

    toast(
      error.message
    );

  }

}


function renderVolumes(volumes) {

  const table =
    document.getElementById(
      "volumeTable"
    );


  table.innerHTML = "";


  if (!volumes.length) {

    table.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty">
            No volumes found.
          </div>
        </td>
      </tr>
    `;

    return;

  }


  volumes.forEach(volume => {

    const row =
      document.createElement("tr");


    row.innerHTML = `

      <td class="mono">
        ${escapeHtml(volume.volumeId)}
      </td>

      <td>
        ${escapeHtml(volume.device)}
      </td>

      <td>
        ${volume.size} GB
      </td>

      <td>
        ${escapeHtml(volume.type)}
      </td>

      <td>
        ${statusHtml(volume.state)}
      </td>

      <td>
        ${volume.encrypted ? "Yes" : "No"}
      </td>

      <td>
        ${escapeHtml(volume.availabilityZone)}
      </td>

      <td>

        <button
          class="btn btn-primary btn-small"
          onclick="openSnapshotModal('${volume.volumeId}')"
        >
          Snapshot
        </button>

      </td>

    `;


    table.appendChild(row);

  });

}


function openSnapshotModal(volumeId) {

  selectedVolume =
    volumeId;


  document.getElementById(
    "snapshotVolume"
  ).value =
    volumeId;


  document.getElementById(
    "snapshotModal"
  ).classList.add(
    "open"
  );

}


function closeSnapshotModal() {

  document.getElementById(
    "snapshotModal"
  ).classList.remove(
    "open"
  );

}


async function createSnapshot() {

  if (!selectedVolume) {
    return;
  }


  const description =
    document.getElementById(
      "snapshotDescription"
    ).value;


  if (
    !confirm(
      `Create snapshot for ${selectedVolume}?`
    )
  ) {
    return;
  }


  try {

    toast(
      "Creating snapshot..."
    );


    const response =
      await fetch(
        "/api/snapshots",
        {

          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            region:
              getRegion(),

            volumeId:
              selectedVolume,

            description

          })

        }
      );


    const result =
      await response.json();


    if (!response.ok) {

      throw new Error(
        result.message
      );

    }


    closeSnapshotModal();


    toast(
      `Snapshot ${result.snapshot.snapshotId} created.`
    );


  } catch (error) {

    toast(
      error.message
    );

  }

}


document.addEventListener(
  "DOMContentLoaded",
  loadInstancesForDropdown
);
